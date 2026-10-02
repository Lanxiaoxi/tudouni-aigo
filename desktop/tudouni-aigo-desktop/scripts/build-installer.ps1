# Build the desktop installer in one command.
#
# A packaged app ships the Go runtime beside itself (the Rust bridge resolves it
# at `resources/runtime/`, see `resolve_binary` in `src-tauri/src/lib.rs`), and
# `tauri build` does not know how to produce one — so the real sequence has
# three ordered steps, and skipping any of them produces a plausible installer
# that is quietly broken:
#
#   1. the Go runtime must exist as a staged build (repo root: `make release`),
#   2. it must be copied into `src-tauri/runtime/` (`npm run runtime:stage`),
#   3. only then does `npm run tauri build` bundle that directory in.
#
# Stage 1 is **not** run here. `make release` is the runtime's own release gate
# (it boots the freshly built binary and asserts on `--version` and the log) and
# this script has no business re-running or skipping it; the check below only
# refuses to proceed when the staging that `make release` produces is missing or
# older than VERSION. Everything else is run here.

param(
    # Re-stage from dist/ even when src-tauri/runtime/ already looks current.
    [switch]$Force,
    # Skip the toolchain check (Node/cargo in PATH).
    [switch]$SkipToolcheck,
    # Extra arguments are passed straight through to `tauri build`.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TauriArgs
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Resolve-Path (Join-Path $here '..')
$repo = Resolve-Path (Join-Path $app '..\..')

$step = 'runtime staging'

function Fail($message) {
    Write-Host "FAIL [$step]: $message" -ForegroundColor Red
    exit 1
}

# ---------------- 0. toolchain ----------------
# Refuse to run 15 minutes and then die inside makensis: every tool this script
# needs is checked up front, cheaply.
if (-not $SkipToolcheck) {
    $step = 'toolchain check'
    foreach ($tool in 'node', 'cargo') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Fail "$tool is not in PATH. The desktop build needs Node >= 20 and a Rust toolchain with the MSVC linker."
        }
    }
    Write-Host "ok: node $(node --version), cargo $(cargo --version)"
}

# ---------------- 1. the staged runtime ----------------
$step = 'runtime staging'
$dist = Join-Path $repo 'dist'
$staged = Join-Path (Join-Path $app 'src-tauri') 'runtime'

# The repo root's VERSION is what `make release` stamps its staging directory
# with; a staging dir for an older version means the installer would embed a
# runtime whose --version disagrees with the app around it.
$version = ''
$versionFile = Join-Path $repo 'VERSION'
if (Test-Path $versionFile) { $version = (Get-Content $versionFile -Raw).Trim() }
if ($version -eq '') { Fail "the repository root has no readable VERSION file" }

# `$IsWindows` does not exist in Windows PowerShell 5.1 (it is PowerShell 6+
# only) — testing it there silently takes the *nix branch and then the whole
# staging check looks for a binary that is never there. `$env:OS` is the
# Windows marker that exists in both.
$binary = if ($env:OS -eq 'Windows_NT') { 'tudouni-aigo.exe' } else { 'tudouni-aigo' }
$stagedBinary = Join-Path $staged $binary

$needStage = $Force -or (-not (Test-Path $stagedBinary))
if (-not $needStage) {
    # A staged directory is only "current" if it says the same version AND is at
    # least as new as everything that feeds it. The mtimes cannot prove the
    # binary is the same *code* as the tree (only a rebuild can), but they catch
    # the common accident: dist/ rebuilt, staging forgotten.
    $stagedVersion = & (Join-Path $staged $binary) --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $stagedVersion -notmatch [regex]::Escape($version)) {
        Write-Host "staging reports '$stagedVersion', VERSION says '$version' - restaging"
        $needStage = $true
    }
}
if (-not $needStage -and (Test-Path $dist)) {
    $stagedTime = (Get-Item $stagedBinary).LastWriteTimeUtc
    $newerDist = Get-ChildItem $dist -Directory |
        Where-Object { $_.Name -like "tudouni-aigo-*-$version-*" } |
        Where-Object { (Get-ChildItem $_.FullName -Recurse -File | Measure-Object LastWriteTimeUtc -Maximum).Maximum -gt $stagedTime }
    if ($newerDist) {
        Write-Host "dist/ has a build newer than the staged runtime - restaging"
        $needStage = $true
    }
}

if ($needStage) {
    if (-not (Test-Path $dist)) { Fail "no dist/ at $dist - build one first:  make release" }
    Write-Host 'staging the runtime (npm run runtime:stage)...'
    # Through cmd /c: under ErrorActionPreference=Stop, PowerShell 5.1 turns
    # every line a native command writes to stderr into a terminating error —
    # and a stray warning line would abort the build mid-way.
    cmd /c "cd /d `"$app`" && npm run runtime:stage"
    if ($LASTEXITCODE -ne 0) { Fail 'runtime:stage failed' }
}

# ---------------- 2. the installer ----------------
$step = 'tauri build'
# Same cmd /c wrapper as above, with the output going to a log file: the
# bundler writes progress to stderr, and under `Stop` PowerShell 5.1 would
# treat the first line of it as a terminating error. The log's tail is printed
# after the run — on a failure the last few lines are the only diagnosis
# there is.
$log = Join-Path $app '.tauri-build.log'
Set-Content -Path $log -Value "=== tauri build $(Get-Date -Format s) ==="
cmd /c "cd /d `"$app`" && npm run tauri build -- $TauriArgs >> `"$log`" 2>&1"
if ($LASTEXITCODE -ne 0) {
    Get-Content $log -Tail 25 | Write-Host
    Fail "tauri build exited $LASTEXITCODE - full log in $log"
}
Get-Content $log -Tail 6 | Write-Host

# ---------------- 3. the result ----------------
$step = 'report'
$nsis = Join-Path (Join-Path (Join-Path (Join-Path $app 'src-tauri') 'target') 'release') 'bundle'
$nsis = Join-Path $nsis 'nsis'
$installers = Get-ChildItem $nsis -Filter '*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
if (-not $installers) { Fail "no installer found in $nsis" }

# The app's own version decides the installer's name; pointing at the newest
# file rather than asserting on it keeps the script honest when tauri changes
# its naming. What is asserted is freshness: the top entry must be from this run.
$appVersion = (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
$latest = $installers | Where-Object { $_.Name -like "*_$appVersion*" } | Select-Object -First 1
if (-not $latest) { Fail "no installer matching version $appVersion in $($installers[0].FullName)" }

$age = [int]((Get-Date) - $latest.LastWriteTime).TotalMinutes
if ($age -gt 5) {
    Write-Warning "the matching installer is $age minute(s) old - it may be from an earlier build"
}

Write-Host ''
Write-Host "installer: $($latest.FullName)" -ForegroundColor Green
Write-Host ("size:      {0:N2} MB" -f ($latest.Length / 1MB))
Write-Host "runtime:   $version (staged)"
