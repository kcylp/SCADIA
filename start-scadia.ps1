<#
.SYNOPSIS
  可靠启动 开诚智枢 SCADIA 服务端（含前置检查与可选沙箱模式）。

.DESCRIPTION
  原交付包 (00_交付说明.md) 的手工步骤有几处容易踩坑：
    - 它假设 node_modules 已存在（交付包不含）
    - 它假设 client/dist 已构建（交付包不含）
    - 它让你 cp -r project/_appdata source/server/，那会嵌套成 _appdata/_appdata
  本脚本用 --userDir 直接指向工程目录，避免复制，也就没有嵌套问题。

  服务端的目录解析（main.js:58-68）是：
    rootDir = --userDir（默认 __dirname = source/server）
    workDir = <rootDir>/_appdata
    _db / _images / _logs 等都在 <rootDir> 下
  仓库里 project/ 下正好就是 _appdata + _db + _images，所以：
    --userDir <仓库>\project   即可，无需任何复制。

.PARAMETER Sandbox
  沙箱模式（推荐先跑它）：把工程数据复制到临时目录再启动，
  绝不写你的 project/。用于验证服务能起来、界面能打开。

.PARAMETER Port
  监听端口，默认 1881。

.EXAMPLE
  .\start-scadia.ps1 -Sandbox          # 安全验证（不碰 project/）
  .\start-scadia.ps1                   # 用真实工程运行（会写 project/ 的库）
#>
[CmdletBinding()]
param(
    [switch]$Sandbox,
    [int]$Port = 1881,
    [switch]$Rebuild,
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
# 90-AH: prefer the Node runtime shipped inside this package, so the machine needs no install.
$nodeExe = Join-Path $repo 'runtime\node\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
$serverDir = Join-Path $repo 'source\server'
$clientDir = Join-Path $repo 'source\client'
$projectDir = Join-Path $repo 'project'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Write-Bad($m)  { Write-Host "    !!  $m" -ForegroundColor Red }

Write-Step '1/5 前置检查'
if (-not (Test-Path $serverDir)) { Write-Bad "找不到 $serverDir"; exit 1 }
if (-not (Test-Path (Join-Path $serverDir 'main.js'))) { Write-Bad 'server/main.js 缺失'; exit 1 }
Write-Ok 'server 目录存在'

if (-not (Test-Path (Join-Path $serverDir 'node_modules'))) {
    Write-Bad 'node_modules 不存在 —— 交付包不含依赖'
    Write-Host '       请先执行:  cd "'$serverDir'"; npm install'
    exit 1
}
Write-Ok 'server 依赖已安装'

$dist = Join-Path $clientDir 'dist\index.html'
if ($Rebuild -or -not (Test-Path $dist)) {
    Write-Step '2/5 构建前端（client/dist 缺失或要求重建）'
    if (-not (Test-Path (Join-Path $clientDir 'node_modules'))) {
        Write-Bad 'client/node_modules 不存在，请先 cd "'$clientDir'"; npm install'
        exit 1
    }
    Push-Location $clientDir
    try { npx ng build; if ($LASTEXITCODE -ne 0) { throw 'ng build 失败' } }
    finally { Pop-Location }
    Write-Ok '前端构建完成'
} else {
    Write-Step '2/5 前端产物已存在，跳过构建'
    Write-Ok $dist
}

Write-Step '3/5 准备工程数据目录'
if (-not (Test-Path $projectDir)) { Write-Bad "找不到 $projectDir"; exit 1 }
foreach ($d in '_appdata', '_db', '_images') {
    if (-not (Test-Path (Join-Path $projectDir $d))) { Write-Bad "project/$d 缺失"; exit 1 }
}
Write-Ok 'project/ 结构完整（_appdata + _db + _images）'

if ($Sandbox) {
    $runDir = Join-Path $env:TEMP ('scadia-run-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null
    foreach ($d in '_appdata', '_db', '_images') {
        Copy-Item (Join-Path $projectDir $d) (Join-Path $runDir $d) -Recurse -Force
    }
    Write-Ok "沙箱运行目录: $runDir（project/ 不会被写入）"
} elseif ($DataDir) {
    if (-not (Test-Path $DataDir)) { Write-Bad "指定的数据目录不存在: $DataDir"; exit 1 }
    $runDir = (Resolve-Path $DataDir).Path
    Write-Ok "使用外部数据目录: $runDir（代码在此仓，数据在指定目录）"
} else {
    $runDir = $projectDir
    Write-Host '    !!  直接使用 project/：服务端会写入 _appdata 下的库（报警/相机/调度等）' -ForegroundColor Yellow
    Write-Host '    !!  建议先备份 project/，或改用 .\start-scadia.ps1 -Sandbox' -ForegroundColor Yellow
}

Write-Step '4/5 检查端口'
$inUse = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Bad "端口 $Port 已被占用 (PID $($inUse[0].OwningProcess))"
    Write-Host "       换端口:  .\start-scadia.ps1 -Port 1882"
    exit 1
}
Write-Ok "端口 $Port 空闲"

Write-Step '4.5/5 启动实时视频代理（可选）'
$proxyScript = Join-Path $repo 'source\tools\mjpeg-proxy.cjs'
$proxyProc = $null
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $Sandbox -and $ff -and (Test-Path $proxyScript)) {
    # 一个源只拉一次 RTSP，多个画面窗共享；缺依赖时明确标记不可用。
    # 路径里有空格与中文：Start-Process 不会自动加引号，参数必须自己包起来，
    # 否则 node 收到的是被截断的路径，进程直接起不来（实测踩过这个坑）。
    $proxyLog = Join-Path $projectDir '_logs\mjpeg-proxy.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $proxyLog) | Out-Null
    $proxyArgs = @('"' + $proxyScript + '"', '"' + (Join-Path $runDir '_appdata\mjpeg-sources.json') + '"')
    $proxyProc = Start-Process -FilePath $nodeExe -ArgumentList $proxyArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $proxyLog -RedirectStandardError ($proxyLog + '.err')
    Write-Ok "实时视频代理已启动 :1886（MJPEG，供画面里的视频窗使用）"
} else {
    Write-Host '    (未启动视频代理：沙箱不启动现场辅助服务；缺少 ffmpeg 时实时视频和检测不可用，页面会显示离线)' -ForegroundColor Yellow
}

Write-Step '4.6/5 启动相机事件桥接器（可选）'
$bridgeScript = Join-Path $repo 'source\tools\scadia-event-bridge.cjs'
$bridgeCfg = Join-Path $runDir '_appdata\video-events.json'
$bridgeProc = $null
if (-not $Sandbox -and (Test-Path $bridgeScript) -and (Test-Path $bridgeCfg)) {
    # 把相机自带事件（遮挡/区域入侵/移动/视频丢失）送进平台：报警、计数、画面出框都靠它。
    # 与视频代理同样：路径含空格与中文，参数必须自己加引号。
    $bridgeLog = Join-Path $projectDir '_logs\event-bridge.log'
    $bridgeArgs = @('"' + $bridgeScript + '"', '"' + $bridgeCfg + '"')
    $bridgeProc = Start-Process -FilePath $nodeExe -ArgumentList $bridgeArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $bridgeLog -RedirectStandardError ($bridgeLog + '.err')
    Write-Ok '相机事件桥接器已启动（遮挡/入侵/移动 → 平台报警与计数）'
} else {
    Write-Host '    (跳过事件桥接器：缺少 source\tools\scadia-event-bridge.cjs 或 project/_appdata/video-events.json)' -ForegroundColor Yellow
}

Write-Step '4.7/5 启动人体检测与轨迹追踪服务（可选）'
$trackerScript = Join-Path $repo 'source\tools\scadia-ai-tracker.py'
$trackerCfg = Join-Path $runDir '_appdata\ai-tracker.json'
$trackerProc = $null
# 找可用的 Python：本机 'python' 可能是 WindowsApps 的商店占位符（能查到路径但一跑就报错），
# 所以必须真的执行一次 --version 验证，而不是只看 Get-Command 有没有结果。
$pyExe = $null; $pyArgs = @()
foreach ($cand in @(@('py', '-3'), @('python', ''), @('python3', ''))) {
    $exe = (Get-Command $cand[0] -ErrorAction SilentlyContinue).Source
    if (-not $exe) { continue }
    $extra = @(); if ($cand[1]) { $extra = @($cand[1]) }
    $v = & $exe @extra --version 2>&1
    if ($LASTEXITCODE -eq 0 -and ($v -join ' ') -match 'Python 3') { $pyExe = $exe; $pyArgs = $extra; break }
}
if (-not $Sandbox -and $pyExe -and (Test-Path $trackerScript) -and (Test-Path $trackerCfg)) {
    # 人体检测 + 轨迹追踪：相机原生给不了"人在哪、走过哪条线"，必须外接模型。
    # 依赖：pip install ultralytics opencv-python；有 N 卡的工作站装 CUDA 版 torch 即自动用卡。
    $trackerLog = Join-Path $projectDir '_logs\ai-tracker.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $trackerLog) | Out-Null
    $trackerFull = $pyArgs + @('"' + $trackerScript + '"', '"' + $trackerCfg + '"')
    $trackerProc = Start-Process -FilePath $pyExe -ArgumentList $trackerFull -PassThru -WindowStyle Hidden -RedirectStandardOutput $trackerLog -RedirectStandardError ($trackerLog + '.err')
    Write-Ok ('人体检测与轨迹追踪服务已启动（YOLOv8 + ByteTrack，' + $pyExe + '）')
} else {
    Write-Host '    (跳过追踪服务：未找到可用 Python 3，或缺少 source\tools\scadia-ai-tracker.py / project/_appdata/ai-tracker.json)' -ForegroundColor Yellow
    Write-Host '    依赖安装：pip install ultralytics opencv-python   （有显卡的工作站装 CUDA 版 torch 即可自动用卡）' -ForegroundColor Yellow
}

$thermalTrackerProc = $null
$thermalTrackerCfg = Join-Path $runDir '_appdata\ai-tracker-thermal.json'
if (-not $Sandbox -and $pyExe -and (Test-Path $trackerScript) -and (Test-Path $thermalTrackerCfg)) {
    $thermalLog = Join-Path $projectDir '_logs\ai-tracker-thermal.log'
    $thermalArgs = $pyArgs + @('"' + $trackerScript + '"', '"' + $thermalTrackerCfg + '"')
    $thermalTrackerProc = Start-Process -FilePath $pyExe -ArgumentList $thermalArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $thermalLog -RedirectStandardError ($thermalLog + '.err')
    Write-Ok '红外独立辅助检测已启动（独立通道、轨迹文件；不套用可见光围栏或安全帽检测）'
}

Write-Step '4.8/5 启动 VLM 视觉理解服务（可选）'
$vlmScript = Join-Path $repo 'source\tools\scadia-scene-review.py'
$vlmCfg = Join-Path $runDir '_appdata\vlm.json'
$vlmProc = $null
# VLM 是"事件级"视觉理解（对报警抓拍图出中文描述），与逐帧的追踪器互补。
# 依赖本地模型目录（vlm.json 的 model_dir），运行期不联网；缺模型就跳过，不影响主程序。
$vlmModelDir = $null
if (Test-Path $vlmCfg) {
    # vlm.json 是无 BOM 的 UTF-8（含中文 prompt），PS 5.1 默认按 GBK 读会乱码，必须显式 -Encoding UTF8
    try { $vlmModelDir = (Get-Content $vlmCfg -Raw -Encoding UTF8 | ConvertFrom-Json).model_dir } catch { $vlmModelDir = $null }
}
if (-not $Sandbox -and $pyExe -and (Test-Path $vlmScript) -and (Test-Path $vlmCfg) -and $vlmModelDir -and (Test-Path $vlmModelDir)) {
    $vlmLog = Join-Path $projectDir '_logs\vlm.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $vlmLog) | Out-Null
    $vlmFull = $pyArgs + @('"' + $vlmScript + '"', '"' + $vlmCfg + '"')
    $vlmProc = Start-Process -FilePath $pyExe -ArgumentList $vlmFull -PassThru -WindowStyle Hidden -RedirectStandardOutput $vlmLog -RedirectStandardError ($vlmLog + '.err')
    Write-Ok 'VLM 八场景复核主管已启动（单工作进程、事件优先与周期轮询、硬超时回收）'
} else {
    Write-Host '    (跳过 VLM 服务：缺 Python 3 / source\tools\scadia-vlm.py / project/_appdata/vlm.json，或模型目录不存在)' -ForegroundColor Yellow
}

Write-Step '5/5 启动服务端'
Write-Host "    地址: http://127.0.0.1:$Port/" -ForegroundColor White
Write-Host '    登录: 使用工程配置的授权账号' -ForegroundColor White
Write-Host '    停止: Ctrl+C' -ForegroundColor White
Write-Host ''

# The server logs warnings to stderr. Running it as a native foreground command with
# $ErrorActionPreference='Stop' turns the first stderr write into a TERMINATING error and
# kills the just-started server. Launch it as a child process with redirected output instead.
$serverLog = Join-Path $projectDir '_logs\server.log'
$serverErr = Join-Path $projectDir '_logs\server.err.log'
New-Item -ItemType Directory -Force -Path (Split-Path $serverLog) | Out-Null
$serverArgs = @('main.js', '--port', $Port, '--userDir', ('"' + $runDir + '"'))
$serverProc = $null
Push-Location $serverDir
try {
    $serverProc = Start-Process -FilePath $nodeExe -ArgumentList $serverArgs -WorkingDirectory $serverDir -PassThru -NoNewWindow -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr
    $serverProc.WaitForExit()
    Write-Host "    服务端已退出（ExitCode=$($serverProc.ExitCode)）" -ForegroundColor Yellow
} finally {
    if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue }
    if ($proxyProc -and -not $proxyProc.HasExited) { Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue }
    if ($bridgeProc -and -not $bridgeProc.HasExited) { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue }
    if ($trackerProc -and -not $trackerProc.HasExited) { Stop-Process -Id $trackerProc.Id -Force -ErrorAction SilentlyContinue }
    if ($thermalTrackerProc -and -not $thermalTrackerProc.HasExited) { Stop-Process -Id $thermalTrackerProc.Id -Force -ErrorAction SilentlyContinue }
    if ($vlmProc -and -not $vlmProc.HasExited) { Stop-Process -Id $vlmProc.Id -Force -ErrorAction SilentlyContinue }
    Pop-Location
}
