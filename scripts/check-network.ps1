# tudouni 网络自检
#
# 目的：一眼看出"这次 LLM 调用会不会失败"。围绕一个事实设计 ——
# tudouni（Go）只认 HTTPS_PROXY 环境变量，**不读** Windows 系统代理，
# 所以"浏览器能上网"完全不能说明 tudouni 能上网。
#
# 用法：pwsh -File scripts/check-network.ps1
#       （在仓库根目录跑；也可以直接在终端里粘贴执行）
# 不需要管理员权限，不改任何系统设置。

$ErrorActionPreference = 'SilentlyContinue'
$proxy  = 'http://127.0.0.1:7897'
$target = 'https://opencode.ai/zen/go/v1/models'
$port   = 7897

function Line($label, $ok, $detail) {
    # 三元/内联 if 在 Windows PowerShell 5.1 上不合法，这里用两条赋值：
    # 这个脚本要能在 5.1 和 7 上跑。
    $mark = '[FAIL]'
    if ($ok) { $mark = '[ OK ]' }
    Write-Host ("{0} {1,-32} {2}" -f $mark, $label, $detail)
}

Write-Host ''
Write-Host '=== 1. 这一层的事实 ===' -ForegroundColor Cyan

# 环境变量：这才是 tudouni 唯一认的东西
$envHttp = $env:HTTPS_PROXY
$envUser = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'User')
$envMach = [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'Machine')
Line 'HTTPS_PROXY (本进程)' $true ("[$envHttp]")
Line 'HTTPS_PROXY (用户级)' $true ("[$envUser]")
Line 'HTTPS_PROXY (机器级)' $true ("[$envMach]")

# 系统代理：浏览器认，tudouni 不认
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Line '系统代理 ProxyEnable' ([bool]$reg.ProxyEnable) "=$($reg.ProxyEnable)  ProxyServer=$($reg.ProxyServer)"
if ($reg.AutoConfigURL) { Line 'PAC (AutoConfigURL)' $true $reg.AutoConfigURL }

# 代理端口在不在
$listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded
Line "Clash 端口 $port 在监听" $listening ''

Write-Host ''
Write-Host '=== 2. 结论 ===' -ForegroundColor Cyan

if (-not $envHttp) {
    Write-Host '  HTTPS_PROXY 是空的 -> tudouni 会走【直连】。' -ForegroundColor Yellow
    Write-Host '  这跟浏览器能不能上网无关：浏览器认系统代理，tudouni 不认。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  修法（一次性，之后新开的终端都生效）：' -ForegroundColor Green
    Write-Host "      [Environment]::SetEnvironmentVariable('HTTPS_PROXY','$proxy','User')" -ForegroundColor Green
    Write-Host '  然后【新开】一个终端再启动 tudouni —— 顺序不能反，' -ForegroundColor Green
    Write-Host '  Go 在首次使用时缓存代理配置，启动后再设没有用。' -ForegroundColor Green
} else {
    Write-Host '  HTTPS_PROXY 已设置 -> tudouni 会走代理。' -ForegroundColor Green
}

if (-not $listening) {
    Write-Host "  另外：$port 没有在监听 —— SakuraCat 没启动，代理必然失败。" -ForegroundColor Yellow
} elseif (-not $reg.ProxyEnable) {
    Write-Host "  注意：$port 在监听，但系统代理是关的。端口在 != 能上网：" -ForegroundColor Yellow
    Write-Host '  SakuraCat 开着但没点连接时，那个端口接受连接却转不出流量。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 3. 实测（直连 vs 代理）===' -ForegroundColor Cyan

function TimeIt($label, $useProxy) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($useProxy) { Invoke-WebRequest -Uri $target -Proxy $proxy -TimeoutSec 20 -ErrorAction Stop | Out-Null }
        else           { Invoke-WebRequest -Uri $target -TimeoutSec 20 -ErrorAction Stop | Out-Null }
        $sw.Stop()
        Line $label $true ("HTTP 200  {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    } catch {
        $sw.Stop()
        $msg = ($_.Exception.Message -replace '\s+', ' ')
        Line $label $false ("{0:N1}s  {1}" -f $sw.Elapsed.TotalSeconds, $msg)
    }
}

TimeIt '直连'   $false
TimeIt '走代理' $true

Write-Host ''
Write-Host '  读法：' -ForegroundColor DarkGray
Write-Host '    直连失败 + 走代理成功  -> 就是 tudouni 的处境，设 HTTPS_PROXY 即可。' -ForegroundColor DarkGray
Write-Host '    两个都失败            -> SakuraCat 没连上（或端口变了）。' -ForegroundColor DarkGray
Write-Host '    两个都成功            -> 网络本来就好，失败是偶发。' -ForegroundColor DarkGray
Write-Host ''
