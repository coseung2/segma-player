$ErrorActionPreference = 'Stop'
$package = Join-Path $env:USERPROFILE 'Downloads\AuraYouTubePackage'
$service = Join-Path $env:USERPROFILE 'AppData\Local\Aura YouTube'
$taskName = 'Aura YouTube Service'

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Copy-Item -LiteralPath (Join-Path $package 'app.js') -Destination (Join-Path $service 'app.js') -Force
Copy-Item -LiteralPath (Join-Path $package 'youtube-quality.cjs') -Destination (Join-Path $service 'youtube-quality.cjs') -Force
Start-ScheduledTask -TaskName $taskName

$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/healthz' -TimeoutSec 2
    break
  } catch {
    $health = $null
  }
} while ((Get-Date) -lt $deadline)

if (-not $health.ok) {
  throw 'Aura YouTube health check failed after deployment.'
}

[ordered]@{
  taskState = [string](Get-ScheduledTask -TaskName $taskName).State
  health = $health
} | ConvertTo-Json -Depth 5 -Compress
