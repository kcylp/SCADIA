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
    [switch]$Rebuild
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

Write-Step '5/5 启动服务端'
Write-Host "    地址: http://127.0.0.1:$Port/" -ForegroundColor White
Write-Host '    登录: admin / 123456（安全默认为关闭，通常无需登录）' -ForegroundColor White
Write-Host '    停止: Ctrl+C' -ForegroundColor White
Write-Host ''

Push-Location $serverDir
try {
    & $nodeExe main.js --port $Port --userDir $runDir
} finally {
    Pop-Location
}
