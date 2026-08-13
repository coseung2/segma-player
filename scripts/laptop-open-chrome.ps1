$ErrorActionPreference = "Continue"
$lines = @()
try {
  $action = New-ScheduledTaskAction -Execute "C:\Program Files\Google\Chrome\Application\chrome.exe" -Argument "--remote-debugging-port=9222 --user-data-dir=C:\Users\malla\aura-yt-chrome https://www.youtube.com"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "desktop-8n966j0\bossng2" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName "AuraCookieChrome" -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
  $lines += "registered"
  Start-ScheduledTask -TaskName "AuraCookieChrome"
  $lines += "start-requested"
} catch {
  $lines += ("error=" + $_.Exception.Message)
}
Start-Sleep -Seconds 6
try {
  $probe = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 5
  $lines += ("cdp=" + $probe.StatusCode)
  $lines += ("browser=" + ((ConvertFrom-Json $probe.Content).Browser))
} catch {
  $lines += "cdp=no-cdp"
}
$lines | Write-Output
$report = "C:\Users\malla\Downloads\aura-open-chrome-report.txt"
$lines | Set-Content -LiteralPath $report -Encoding UTF8
