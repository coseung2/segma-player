$ErrorActionPreference = "Continue"
$report = "C:\Users\malla\Downloads\aura-admin-report.txt"
$lines = @()

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$lines += ("admin=" + $isAdmin)

$lines += "=== lid set ==="
$lines += (powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>&1 | Out-String).Trim()
$lines += (powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>&1 | Out-String).Trim()
$lines += (powercfg /setactive SCHEME_CURRENT 2>&1 | Out-String).Trim()
$lines += "=== lid query ==="
$lines += (& powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION 2>&1 | Out-String)

$lines += "=== app.js bind ==="
$serviceApp = "C:\Users\malla\AppData\Local\Aura YouTube\app.js"
if (Test-Path -LiteralPath $serviceApp) {
  $text = Get-Content -LiteralPath $serviceApp -Raw -Encoding UTF8
  if ($text -match 'listen\(PORT, "127\.0\.0\.1"') {
    $text = $text -replace 'listen\(PORT, "127\.0\.0\.1"', 'listen(PORT, "0.0.0.0"'
    [System.IO.File]::WriteAllText($serviceApp, $text, (New-Object System.Text.UTF8Encoding($false)))
    $lines += "appjs-bind=patched"
  } else {
    $lines += "appjs-bind=no-match"
  }
} else {
  $lines += "appjs-missing"
}

$lines += "=== firewall ==="
$lines += (netsh advfirewall firewall add rule name="Aura YouTube Tailscale" dir=in action=allow protocol=TCP localport=8788 remoteip=100.64.0.0/10 2>&1 | Out-String).Trim()

$lines += "=== restart task ==="
$lines += ((Stop-ScheduledTask -TaskName "Aura YouTube Service" -ErrorAction SilentlyContinue 2>&1 | Out-String).Trim())
Start-Sleep -Seconds 1
$lines += ((Start-ScheduledTask -TaskName "Aura YouTube Service" 2>&1 | Out-String).Trim())
Start-Sleep -Seconds 4
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/healthz" -TimeoutSec 8
  $lines += ("health=" + ($health | ConvertTo-Json -Compress))
} catch {
  $lines += ("health-error=" + $_.Exception.Message)
}

$lines | Set-Content -LiteralPath $report -Encoding UTF8
