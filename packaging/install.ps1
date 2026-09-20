#Requires -Version 5.1
#
# **这个文件必须存成「UTF-8 带 BOM」。**
#
# Windows PowerShell 5.1 读 .ps1 时，如果文件没有 BOM，就按系统 ANSI 代码页解码 ——
# 下面那些中文注释会变成乱码，而乱码里只要出现一个引号类的字节，整个脚本就解析不过去。
# 也就是说：**去掉 BOM 会让这个脚本在用户机器上直接跑不起来**，而它在 UTF-8 的编辑器里
# 看完全正常。`tools/release`（`go run ./tools/release`）里有一步检查盯着这件事。
#
<#
把 tudouni-aigo 装到这台机器上。**只装给当前用户，不需要管理员权限。**

用法：把压缩包完整解压，在解压出来的目录里跑

    .\install.ps1

装到哪儿：%LOCALAPPDATA%\Programs\tudouni-aigo，并把这个目录加进**用户** PATH。
重复运行就是覆盖升级，不会留下第二份。

装过去的是三样：`tudouni-aigo.exe`、`prompts\`、`tools\`。后两样不是装饰 ——
程序用 `prompts\` 这个目录的存在来认出"这就是我自己的目录"，随包的 ripgrep
就在它下面的 `tools\vendor\rg\...` 里。少哪一个，`grep` 工具会**静默消失**。

同一个目录里还会多放一份 `tudouni.exe`：命令改过名字，而旧的笔记和脚本里写的是
老名字，留一个别名比让它们静默变成"找不到命令"便宜。
#>

$ErrorActionPreference = 'Stop'

$Source = $PSScriptRoot
$Target = Join-Path $env:LOCALAPPDATA 'Programs\tudouni-aigo'
$Exe = Join-Path $Target 'tudouni-aigo.exe'
# The previous release installed itself under the old command's name. That directory
# is still on PATH on an upgraded machine and its copy of the old build answers to
# exactly the `tudouni` the alias below is meant to serve — so it is removed rather
# than left to shadow the new one. PATH picks by directory order, not by age.
$LegacyTarget = Join-Path $env:LOCALAPPDATA 'Programs\tudouni'
$Alias = Join-Path $Target 'tudouni.exe'

Write-Host ''
Write-Host '  tudouni-aigo 安装' -ForegroundColor Cyan
Write-Host "    来源    $Source"
Write-Host "    安装到  $Target"
Write-Host ''

# --- 0. 先确认这个脚本是**从解压出来的目录**里跑的 ---------------------------
#
# 直接双击压缩包里的 install.ps1 时，Windows 会把脚本解到一个临时目录，而旁边
# 没有 tudouni-aigo.exe。那时候的报错必须说清"先解压"，否则用户看到的是
# "tudouni-aigo.exe 不存在"，而它明明就在压缩包里。
if (-not (Test-Path (Join-Path $Source 'tudouni-aigo.exe')) -or
    -not (Test-Path (Join-Path $Source 'prompts')) -or
    -not (Test-Path (Join-Path $Source 'tools'))) {
    Write-Host '  这个目录里没有 tudouni-aigo.exe / prompts / tools。' -ForegroundColor Red
    Write-Host '  请**先把压缩包完整解压**（右键 → 全部解压缩），再运行解压出来的那个 install.ps1。'
    exit 1
}

# --- 1. 拷贝 ----------------------------------------------------------------
#
# ## 先问一句"有没有正在跑的实例"
#
# 程序正在跑的时候，它的 exe 是被映射着的，覆盖会失败，而 Windows 给的错是
# "对路径的访问被拒绝"——**不是**"文件正被使用"。用户看到的是一个文件路径加一句
# Access denied，看不出该干什么。所以在动任何东西之前先查一遍。
# Both names are checked: the alias is the same program, and a copy running under
# either name holds the same files open.
$running = @(Get-Process -Name 'tudouni-aigo', 'tudouni' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $ids = ($running | ForEach-Object { $_.Id }) -join ', '
    Write-Host "  检测到 tudouni-aigo 正在运行（PID $ids）。" -ForegroundColor Red
    Write-Host '  请先在那些窗口里按 Ctrl+C 退出（或者用任务管理器结束它），'
    Write-Host '  然后重新运行这个脚本 —— 覆盖安装要先替换掉它自己。'
    exit 1
}

# ## 升级时**不原地删**，先把旧的挪到一边
#
# `Remove-Item -Recurse` 是逐个删的：撞上一个删不掉的文件就停在半路，那时旧目录已经
# 被删了一半、新的还没拷进来 —— 用户手上剩一个**坏掉的安装**，而这比单纯报错更糟。
# 改名是同一卷上的一次元数据操作，即使里面有文件被占用也能成功。于是顺序变成：
# 旧的挪开 → 新的完整落位 → 再收旧的。收不掉就留着并说一声：那只是一份垃圾，不是故障。
$aside = $null
if (Test-Path $Target) {
    Write-Host '  已装过一份，覆盖升级……'
    $aside = "$Target.old-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    Move-Item -Path $Target -Destination $aside
}
# The old-named install is moved aside for the same reason it is not left alone: one
# program under two names in two directories is a machine where the version you get
# depends on PATH order.
$legacyAside = $null
if (Test-Path $LegacyTarget) {
    Write-Host '  发现用旧名字装的那一份，一并收走……'
    $legacyAside = "$LegacyTarget.old-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    Move-Item -Path $LegacyTarget -Destination $legacyAside
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null
foreach ($item in @('tudouni-aigo.exe', 'prompts', 'tools')) {
    Copy-Item -Recurse -Force (Join-Path $Source $item) $Target
}
# A copy rather than a hard link: this script upgrades by replacing the whole
# directory, which leaves a link dangling and a copy intact.
Copy-Item -Force $Exe $Alias
if ($aside -or $legacyAside) {
    foreach ($old in @($aside, $legacyAside)) {
        if (-not $old) { continue }
        try {
            Remove-Item -Recurse -Force $old -ErrorAction Stop
        } catch {
            Write-Host "  （旧的安装在 $old 收不掉，可以之后手动删掉它 —— 那份已经不用了）" `
                -ForegroundColor DarkYellow
        }
    }
}
Write-Host '  [1/3] 文件已就位'

# --- 2. 加进用户 PATH -------------------------------------------------------
#
# **用户级，不是机器级**：机器级要管理员，而这个工具本来就不需要。
# 已经在了就不重复加 —— 重复加会让 PATH 一次次变长，而 Windows 对它有长度上限。
#
# 这里有一处**刻意的不自动化**。如果用户 PATH 里还留着没展开的 `%VAR%` 引用
# （注册表里的 REG_EXPAND_SZ），那么读出来的是**展开之后**的值，我们再写回去就把它
# 变成了字面字符串 —— 别人设的 `%JAVA_HOME%` 这类引用就此死掉，而症状要过很久才出现
# 在一个和这里毫无关系的地方。所以那种情况下**不碰它**，让用户自己加一行：
# 宁可多一步，不可悄悄改坏一个我们看不懂的 PATH。
#
# 旧名字的那个目录在同一次写入里一起拿掉：一个程序在 PATH 上有两个目录，最后跑的是
# 哪一个取决于目录顺序而不是新旧，别名再好也救不了。
$pathChanged = $false
$manualPath = $false

$envKey = Get-Item -Path 'HKCU:\Environment' -ErrorAction SilentlyContinue
$rawUserPath = if ($null -ne $envKey -and ($envKey.GetValueNames() -contains 'Path')) {
    [string]$envKey.GetValue(
        'Path', '',
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
} else { '' }

$entries = @($rawUserPath -split ';' | Where-Object { $_ -ne '' })
$staleCount = @($entries | Where-Object { $_ -eq $LegacyTarget }).Count
$entries = @($entries | Where-Object { $_ -ne $LegacyTarget })
$needsTarget = -not ($entries -contains $Target)
$needsCleanup = $staleCount -gt 0

if (-not $needsTarget -and -not $needsCleanup) {
    Write-Host '  [2/3] 用户 PATH 里已经有了'
} elseif ($rawUserPath -like '*%*') {
    $manualPath = $true
    Write-Host '  [2/3] 你的用户 PATH 里有 %VAR% 形式的引用，脚本不替你改' -ForegroundColor Yellow
    if ($needsTarget) {
        Write-Host "       请把这个目录加进去：$Target" -ForegroundColor Yellow
    }
    if ($needsCleanup) {
        Write-Host "       旧的 $LegacyTarget 也还在里面，请一并删掉。" -ForegroundColor Yellow
    }
} else {
    $newEntries = @($entries)
    if ($needsTarget) { $newEntries += $Target }
    [Environment]::SetEnvironmentVariable('Path', ($newEntries -join ';'), 'User')
    $pathChanged = $true
    if ($needsCleanup) {
        Write-Host '  [2/3] 已加进用户 PATH，并把旧名字的目录去掉了'
    } else {
        Write-Host '  [2/3] 已加进用户 PATH'
    }
}

# --- 3. 确认这个二进制真的能跑，并说出它是哪一版 ----------------------------
#
# `--version` 是**最干净**的那个调用：它不碰工作区、不读配置、不需要密钥。所以拿它
# 同时验"装好了没有"和"装的是哪一版"。版本号是**编译进二进制**的，所以这一句说出来的
# 就是你刚装的这一份 —— 它不可能和二进制本身对不上（旧版从旁边的文本文件读版本号，
# 于是"换了 exe 没换成"这种事故会表现为"版本号变了但程序没变"）。
$out = & $Exe --version 2>&1
if ($LASTEXITCODE -ne 0) { throw "tudouni-aigo --version 退出码 $LASTEXITCODE`n$out" }
Write-Host "  [3/3] 装好了：$out"

# --- 收尾 -------------------------------------------------------------------
Write-Host ''
Write-Host '  下一步' -ForegroundColor Cyan
if ($pathChanged) {
    Write-Host '    1) 开一个**新的**终端窗口 —— PATH 是启动时读的，'
    Write-Host '       当前这个窗口里敲 tudouni-aigo 还是找不到。'
} else {
    Write-Host '    1) 开一个新终端窗口（或者继续用当前这个，PATH 里本来就有）'
}
if ($manualPath) {
    Write-Host ''
    Write-Host '       等等 —— 你还要先把下面这个目录加进用户 PATH，脚本没替你加：'
    Write-Host ''
    Write-Host "         $Target" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '       （系统属性 → 高级 → 环境变量 → 用户变量里的 Path → 新建 → 粘贴，'
    Write-Host '         然后开一个新终端。加它的理由见脚本里第 2 步那段注释。）'
}
Write-Host '    2) cd 到你自己的项目目录，然后：'
Write-Host ''
Write-Host '         tudouni-aigo' -ForegroundColor Green
Write-Host ''
Write-Host '   第一次运行会告诉你去哪填密钥。那份文件是：'
Write-Host "         $env:USERPROFILE\.tudouni\config.json"
Write-Host ''
Write-Host '   注意：**别在你自己的用户主目录（或者盘根）下启动它。** 工作区就是'
Write-Host '   你敲命令时所在的那个目录，程序在 home 下会拒绝启动 —— 那等于把整个'
Write-Host '   主目录（含 .ssh、浏览器数据）交给它。'
Write-Host ''
