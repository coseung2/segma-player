$ErrorActionPreference = 'Stop'
$taskName = 'Aura YouTube Service'
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

$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[ordered]@{
  taskState = [string]$task.State
  lastTaskResult = $info.LastTaskResult
  health = $health
} | ConvertTo-Json -Depth 5 -Compress

if (-not $health.ok) {
  throw 'Aura YouTube health check failed after starting scheduled task.'
}
