# Aura YouTube service - laptop install script
# Run this ON THE LAPTOP as the user. Requires: node, yt-dlp.exe, ffmpeg in tools dir.
$ErrorActionPreference = "Stop"
$serviceDir = Join-Path $env:USERPROFILE 'AppData\Local\Aura YouTube'
$toolsDir = Join-Path $env:USERPROFILE 'AppData\Local\AuraDownloader\youtube\tools'

New-Item -ItemType Directory -Force -Path (Join-Path $serviceDir "work") | Out-Null
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

# 1) Copy service files (app.js, cookies.txt) next to this script into serviceDir.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item (Join-Path $scriptDir "app.js") (Join-Path $serviceDir "app.js") -Force
if (Test-Path (Join-Path $scriptDir "cookies.txt")) {
  Copy-Item (Join-Path $scriptDir "cookies.txt") (Join-Path $serviceDir "cookies.txt") -Force
}

# 2) Tools (node/yt-dlp/ffmpeg). If the tools folder in this package exists, copy it.
if (Test-Path (Join-Path $scriptDir "tools")) {
  Copy-Item (Join-Path $scriptDir "tools\*") $toolsDir -Recurse -Force
}

# 3) Verify prerequisites
$node = (Get-Command node -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $toolsDir "node.exe"))
$ytdlp = Test-Path (Join-Path $toolsDir "yt-dlp.exe")
$ffmpeg = Test-Path (Join-Path $toolsDir "ffmpeg\ffmpeg.exe")
Write-Output ("node=" + $node + " ytdlp=" + $ytdlp + " ffmpeg=" + $ffmpeg)
if (-not ($ytdlp -and $ffmpeg)) { throw "yt-dlp/ffmpeg missing in $toolsDir" }

# 4) Start the service now (hidden window) and register a logon task.
$nodeExe = if (Test-Path (Join-Path $toolsDir "node.exe")) { Join-Path $toolsDir "node.exe" } else { "node" }
$scriptArg = '"' + (Join-Path $serviceDir "app.js") + '"'
Start-Process -FilePath $nodeExe -ArgumentList $scriptArg -WorkingDirectory $serviceDir -WindowStyle Hidden

$taskAction = New-ScheduledTaskAction -Execute $nodeExe -Argument $scriptArg -WorkingDirectory $serviceDir
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "Aura YouTube Service" -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Description "Aura YouTube proxy service" -Force | Out-Null

Start-Sleep -Seconds 2
$health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/healthz" -TimeoutSec 5
Write-Output ("HEALTH " + ($health | ConvertTo-Json -Compress))
Write-Output "NEXT: run  tailscale funnel 8788  to publish https://<this-node>.ts.net"
