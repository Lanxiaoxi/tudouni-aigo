# OpenCode Go 连接对照实验
#
# 回答一个具体问题：**不挂代理能不能用？挂了是不是真的更快？**
#
# 设计成一个可记录的实验，而不是"感觉一下"：
#   - 每条路径打 **-n 次**（默认 3），先报每次的原始数字，再报中位数；
#   - 交替顺序（A,B,C,A,B,C…）而不是 A,A,A,B,B,B —— 网络质量在几分钟内会漂移，
#     分组测量会把"后来变好了"记成"B 更好"；
#   - 每条路径都**显式设定或清空** HTTPS_PROXY，不继承当前终端的环境变量，
#     否则量到的可能不是你以为的那条路；
#   - 不打日志文件，结果自己复制粘贴留存。
#
# 注意：这是**真实计费请求**（max_tokens=16，可忽略）。跑完 3 条 × 3 次 = 9 次。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/check-go-connection.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/check-go-connection.ps1 -Model glm-5.3 -Runs 5
#   powershell -ExecutionPolicy Bypass -File scripts/check-go-connection.ps1 -Base https://opencode.ai/zen/go -Style anthropic -Model qwen3.8-flash

param(
    [string] $Key   = 'sk-siVPnrN7cVrJ8mb5KBYB750TqQlDvQWiyzB1CNfCuZEwwXI8BKkYckwqr1NvVvhn',
    [string] $Base  = 'https://opencode.ai/zen/go/v1',
    [string] $Style = 'openai',
    [string] $Model = 'glm-5.3-flash',
    [string] $Proxy = 'http://127.0.0.1:7897',
    [int]    $Runs  = 3,
    [int]    $TimeoutSec = 45
)

$ErrorActionPreference = 'Continue'

function Section($t) { Write-Host ''; Write-Host "=== $t ===" -ForegroundColor Cyan }

# ── 0. 先确认被测量的对象存在 ───────────────────────────────────────────────
Section '0. 前置检查'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'go.mod'))) { $repoRoot = (Get-Location).Path }
$go = Get-Command go -ErrorAction SilentlyContinue
if (-not $go) { Write-Host '找不到 go 命令，无法构建探针。' -ForegroundColor Red; exit 2 }
$env:GOCACHE = Join-Path $repoRoot '.tmp-gocache-netprobe'
$exe = Join-Path $env:TEMP 'tudouni-netprobe.exe'
Write-Host "构建探针 -> $exe"
Push-Location $repoRoot
& go build -o $exe ./tools/netprobe
$built = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $built) { Write-Host '构建失败。' -ForegroundColor Red; exit 2 }

$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Write-Host ("系统代理: ProxyEnable={0}  ProxyServer={1}" -f $reg.ProxyEnable, $reg.ProxyServer)
Write-Host ("Clash 端口 {0} 在监听: {1}" -f $Proxy, (Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -WarningAction SilentlyContinue).TcpTestSucceeded)
Write-Host ''
Write-Host '提醒：跑到这里，请你把 SakuraCat 的**连接**打开（只开程序不够）。' -ForegroundColor Yellow
Write-Host '      如果只想测"完全不挂代理"，那就保持关闭，脚本照样跑，直连那条就是你的基线。' -ForegroundColor Yellow

# ── 1. 往返交替地跑三条路径 ─────────────────────────────────────────────────
$lanes = @(
    @{ id = 'direct'; label = '直连（tudouni 今天的行为）';      via = 'direct'; env = $null },
    @{ id = 'proxy';  label = "代理 $Proxy";                    via = 'proxy';  env = $Proxy },
    @{ id = 'system'; label = '系统代理（浏览器读的那个）';       via = 'system'; env = $null }
)

$raw = @{}
foreach ($lane in $lanes) { $raw[$lane.id] = New-Object System.Collections.ArrayList }

Section "1. 每条路径 $Runs 次（交替往返，避免把网络漂移记成路径差异）"
for ($round = 1; $round -le $Runs; $round++) {
    foreach ($lane in $lanes) {
        if ($lane.env) { $env:HTTPS_PROXY = $lane.env; $env:HTTP_PROXY = $lane.env }
        else           { Remove-Item env:HTTPS_PROXY, env:HTTP_PROXY -ErrorAction SilentlyContinue }

        $output = & $exe -via $lane.via -proxy $Proxy -base $Base -style $Style -model $Model `
                         -key $Key -n 1 -timeout "${TimeoutSec}s" 2>&1
        $text = ($output | Out-String)

        $status = '?'; $reached = $false; $ttfb = $null; $total = $null

        # 分类里有一条容易搞错、但在这个实验里是核心：
        # **任何 HTTP 状态码都算"连上了"。** 对一次 401/400 来说，DNS + TCP + TLS +
        # 请求 + 响应这条链已经全部走完 —— 而本实验要测的正是这条链通不通，
        # 所以 401 是"通"，不是"失败"。把 HTTP 错误算成失败会得出"代理也不通"
        # 的假结论。（用户如果填了真 key，这里就是 200。）
        if ($text -match 'HTTP (\d{3})')                        { $status = "HTTP $($Matches[1])"; $reached = $true }
        elseif ($text -match 'TLS handshake')                   { $status = 'TLS握手超时' }
        elseif ($text -match 'proxy-refused|connection refused'){ $status = '代理拒绝连接' }
        elseif ($text -match 'timed out')                       { $status = '超时' }
        elseif ($text -match 'no Windows system proxy')         { $status = '系统代理未开(ProxyEnable=0)' }
        elseif ($text -match 'PAC script')                      { $status = '系统用 PAC，本探针不解析' }
        elseif ($text -match 'implemented for Windows only')    { $status = '非 Windows，不支持' }
        elseif ($text -match 'FAIL')                            { $status = '其它失败' }

        if ($text -match 'ttfb=([0-9.]+)s')  { $ttfb = [double]$Matches[1] }
        if ($text -match 'total=([0-9.]+)s') { $total = [double]$Matches[1] }

        [void]$raw[$lane.id].Add([pscustomobject]@{
            round = $round; status = $status; reached = $reached; ttfb = $ttfb; total = $total
        })
        $shown = if ($reached) { "$status  ← 连上了" } else { $status }
        Write-Host ("  round {0}  {1,-10} {2}" -f $round, $lane.id, $shown)
    }
}

# ── 2. 汇总 ─────────────────────────────────────────────────────────────────
Section '2. 汇总（中位数）'
Write-Host ("{0,-10} {1,-14} {2,-14} {3}" -f '路径', '连通/总数', 'ttfb 中位数', '结论')
$summary = @{}
foreach ($lane in $lanes) {
    $rows = $raw[$lane.id]
    # "连通"按 reached 算，不按 ttfb —— 一个 401 没有 ttfb，但它确实连上了。
    $ok   = @($rows | Where-Object { $_.reached })
    $med  = $null
    $withTtfb = @($rows | Where-Object { $_.ttfb -ne $null })
    if ($withTtfb.Count -gt 0) {
        $sorted = ($withTtfb | ForEach-Object { $_.ttfb } | Sort-Object)
        $med = $sorted[[int][Math]::Floor($sorted.Count / 2)]
    }
    $verdict = '全部没连上'
    if ($ok.Count -eq $rows.Count)      { $verdict = '每次都连上' }
    elseif ($ok.Count -gt 0)            { $verdict = '时通时不通' }
    $medianText = if ($med -ne $null) { "$($med)s" } else { '—(无流式数据)' }
    Write-Host ("{0,-10} {1,-14} {2,-14} {3}" -f $lane.id, "$($ok.Count)/$($rows.Count)", $medianText, $verdict)
    $summary[$lane.id] = @{ ok = $ok.Count; total = $rows.Count; median = $med }
}

# 把每次的原始状态列出来，便于看清是"偶发"还是"一直"
Section '2b. 每次的原始状态'
foreach ($lane in $lanes) {
    $line = ($raw[$lane.id] | ForEach-Object { "r$($_.round):$($_.status)" }) -join '   '
    Write-Host ("  {0,-10} {1}" -f $lane.id, $line)
}

# ── 3. 怎么读这份结果 ───────────────────────────────────────────────────────
Section '3. 怎么读'
$d = $summary['direct']; $p = $summary['proxy']; $s = $summary['system']
Write-Host '  三条路径各自量的是同一条物理链路的不同走法：' -ForegroundColor DarkGray
Write-Host '    direct = 完全不走代理（tudouni 今天的默认）' -ForegroundColor DarkGray
Write-Host '    proxy  = 显式走 Clash 的 7897' -ForegroundColor DarkGray
Write-Host '    system = 读注册表里的系统代理（浏览器读的那个）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  判据是**连通**，不是 ttfb：一次 401 也算连通（你若填了真 key 就是 200）。' -ForegroundColor DarkGray
Write-Host ''
if ($d.ok -eq 0 -and $p.ok -gt 0) {
    Write-Host '  直连全不通、代理全通 => 结论成立：用 tudouni 必须让代理生效。' -ForegroundColor Green
    Write-Host '     做法：启动前设 HTTPS_PROXY（命令见 scripts/check-network.ps1）。' -ForegroundColor Green
} elseif ($d.ok -eq $d.total -and $p.ok -gt 0) {
    Write-Host '  直连也全通 => **不需要**每次开 VPN。' -ForegroundColor Green
    Write-Host '     那就别设 HTTPS_PROXY：多一跳只会更慢。' -ForegroundColor Green
} elseif ($d.ok -eq 0 -and $p.ok -eq 0) {
    Write-Host '  两条都不通 => 代理没在真正转发（端口在监听不等于能上网）：' -ForegroundColor Yellow
    Write-Host '     确认 SakuraCat 点了"连接"，或者节点本身不可用。' -ForegroundColor Yellow
} else {
    Write-Host '  有通有不通 => 这条链路不稳定，"开不开 VPN"解决不了，' -ForegroundColor Yellow
    Write-Host '     看 2b 的原始状态：失败若集中在某几轮，是网络漂移而不是路径差异。' -ForegroundColor Yellow
}
if ($s.ok -eq $s.total -and $s.total -gt 0 -and $p.ok -lt $p.total) {
    Write-Host '  另外：system 通而 proxy 不通 => 端口大概不是 7897 了，用 -Proxy 指定实际端口。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  想要更硬的证据：把 -Runs 提到 5~10 再跑一次，两轮结论一致才当结论。' -ForegroundColor DarkGray
Write-Host '  （真实计费请求，但 max_tokens=16，费用可忽略。）' -ForegroundColor DarkGray
Write-Host ''
