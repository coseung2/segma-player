$ErrorActionPreference = "Continue"
$report = "C:\Users\malla\Downloads\aura-cookie-task-report.txt"
$lines = @()
try {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Users\malla\Downloads\refresh-youtube-cookies-laptop.ps1" -WorkingDirectory "C:\Users\malla\Downloads"
  $trigger = New-ScheduledTaskTrigger -Daily -At 6:00AM
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName "AuraCookieSync" -Action $action -Trigger $trigger -Settings $settings `
    -User "desktop-8n966j0\bossng2" -Password "temp123" -RunLevel Limited -Force | Out-Null
  $lines += "registered"
} catch {
  $lines += ("error=" + $_.Exception.Message)
}
$task = Get-ScheduledTask -TaskName "AuraCookieSync" -ErrorAction SilentlyContinue
if ($task) {
  $lines += ("state=" + $task.State)
  $lines += ("principal=" + $task.Principal.UserId + " logon=" + $task.Principal.LogonType)
  $lines += ("trigger=" + (($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ","))
  $lines += ("exec=" + $task.Actions.Execute + " " + $task.Actions.Arguments)
} else {
  $lines += "task-missing"
}
$lines | Set-Content -LiteralPath $report -Encoding UTF8
$lines | Write-Output
