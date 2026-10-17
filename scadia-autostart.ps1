# SCADIA auto-start supervisor (portable)
# - Launches the full stack via start-scadia.ps1 (server + mjpeg proxy + event bridge + trackers + VLM)
# - Restarts automatically if the server process exits (crash / accidental close)
# - Path-independent: repo root is derived from this script's location.
# - Optional -DataDir points the server at an external data directory (code in this repo, data elsewhere).
#
# Install on a workstation (hidden at logon), e.g. a .vbs in the Startup folder that runs:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<this>.ps1" -DataDir "<site data dir>"
[CmdletBinding()]
param(
    [string]$DataDir
)

$ErrorActionPreference = 'Continue'
$repo = $PSScriptRoot
$starter = Join-Path $repo 'start-scadia.ps1'
$log = Join-Path $repo 'project\_logs\autostart.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

# Single instance: a second supervisor (e.g. double logon) must not start a duplicate stack.
$mutex = New-Object System.Threading.Mutex($false, 'Global\SCADIA-autostart-supervisor')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Write-Log($m) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    Add-Content -Path $log -Value $line -Encoding UTF8
}

Write-Log ("supervisor started (repo=$repo, dataDir=" + ($(if ($DataDir) { $DataDir } else { '<repo>\project' })) + ")")

$restartDelay = 15
while ($true) {
    if (-not (Test-Path $starter)) {
        Write-Log "start-scadia.ps1 not found at $starter; retry in 60s"
        Start-Sleep -Seconds 60
        continue
    }
    Write-Log 'launching start-scadia.ps1'
    try {
        if ($DataDir) {
            & $starter -DataDir $DataDir *>&1 | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
        } else {
            & $starter *>&1 | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding UTF8 }
        }
    } catch {
        Write-Log ("start-scadia.ps1 threw: {0}" -f $_.Exception.Message)
    }
    Write-Log "server exited; restarting in ${restartDelay}s"
    Start-Sleep -Seconds $restartDelay
}

