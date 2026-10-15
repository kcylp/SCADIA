[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$logDir = Join-Path $repo 'project\_logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# Only stop the SCADIA programs launched with this project's full path.
$names = @('main.js','mjpeg-proxy.cjs','scadia-event-bridge.cjs','scadia-ai-tracker.py','scadia-vlm.py','scadia-scene-review.py')
$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('node.exe','python.exe') -and $_.CommandLine -and $_.CommandLine.Contains($repo) -and ($_.CommandLine -match '(main\.js|mjpeg-proxy\.cjs|scadia-event-bridge\.cjs|scadia-ai-tracker\.py|scadia-vlm\.py|scadia-scene-review\.py)')
}
foreach ($proc in $procs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$launcher = Join-Path $repo 'start-scadia.ps1'
$process = Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$launcher+'"')) -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'scene-launch.log') -RedirectStandardError (Join-Path $logDir 'scene-launch.err')
for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:1881/api/version' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { Write-Output ('SCADIA ready; launcher PID '+$process.Id); exit 0 }
    } catch {}
    if ($process.HasExited) { throw 'SCADIA launcher exited; inspect project/_logs/scene-launch.err' }
}
throw 'SCADIA readiness timeout; inspect project/_logs/scene-launch.log'
