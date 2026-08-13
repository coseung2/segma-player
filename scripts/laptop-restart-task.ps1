Stop-ScheduledTask -TaskName "Aura YouTube Service" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName "Aura YouTube Service"
Start-Sleep -Seconds 3
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/healthz" -TimeoutSec 8
  Write-Output ("health=" + ($health | ConvertTo-Json -Compress))
} catch {
  Write-Output ("health-error=" + $_.Exception.Message)
}
