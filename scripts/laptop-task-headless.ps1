$ErrorActionPreference = "Continue"
$report = "C:\Users\malla\Downloads\aura-task-report.txt"
$lines = @()
try {
  $action = New-ScheduledTaskAction -Execute "C:\Users\malla\AppData\Local\aura-yt-start.cmd" -WorkingDirectory "C:\Users\malla\AppData\Local"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName "Aura YouTube Service" -Action $action -Trigger $trigger -Settings $settings `
    -User "desktop-8n966j0\bossng2" -Password "temp123" -RunLevel Limited -Force | Out-Null
  $lines += "registered"
  Start-ScheduledTask -TaskName "Aura YouTube Service"
  $lines += "started"
  Start-Sleep -Seconds 5
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/healthz" -TimeoutSec 8
  $lines += ("health=" + ($health | ConvertTo-Json -Compress))
} catch {
  $lines += ("error=" + $_.Exception.Message)
}
$task = Get-ScheduledTask -TaskName "Aura YouTube Service" -ErrorAction SilentlyContinue
if ($task) {
  $lines += ("state=" + $task.State)
  $lines += ("principal=" + $task.Principal.UserId + " logon=" + $task.Principal.LogonType)
  $lines += ("trigger=" + ($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ",")
}
$lines | Set-Content -LiteralPath $report -Encoding UTF8
