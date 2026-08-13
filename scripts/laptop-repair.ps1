$ErrorActionPreference = "Continue"
$report = "C:\Users\malla\Downloads\aura-repair-report.txt"
$lines = @()

$lines += "=== identity ==="
$lines += (whoami)
$lines += ("profile=" + $env:USERPROFILE)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$lines += ("admin=" + $isAdmin)

$lines += "=== sshd ==="
try {
  $svc = Get-Service sshd -ErrorAction Stop
  if ($svc.Status -ne "Running") { Start-Service sshd -ErrorAction Continue }
  Set-Service sshd -StartupType Automatic -ErrorAction Continue
  Start-Sleep -Seconds 2
  $svc = Get-Service sshd
  $lines += ("sshd-status=" + $svc.Status + " startup=" + $svc.StartType)
} catch {
  $lines += ("sshd-error=" + $_.Exception.Message)
}

$lines += "=== firewall ssh ==="
$lines += (netsh advfirewall firewall show rule name="OpenSSH-Server-In-TCP" | Out-String).Trim()

$lines += "=== scheduled tasks ==="
$lines += ((schtasks /query /tn "Aura YouTube Service" /fo LIST 2>&1 | Out-String).Trim())

$lines += "=== services ==="
$lines += ((Get-Service | Where-Object { $_.Name -like "*aura*" -or $_.DisplayName -like "*aura*" -or $_.Name -like "*youtube*" } | Select-Object Name,Status,StartType | Out-String).Trim())

$lines += "=== port 8788 ==="
$lines += ((netstat -ano | findstr ":8788" | Out-String).Trim())

$lines += "=== healthz ==="
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:8788/healthz" -UseBasicParsing -TimeoutSec 10
  $lines += ("healthz-status=" + $response.StatusCode + " body=" + $response.Content)
} catch {
  $lines += ("healthz-error=" + $_.Exception.Message)
}

$lines += "=== lid before ==="
$lines += ((powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION | Out-String).Trim())

$lines += "=== lid set ==="
$lines += (powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>&1 | Out-String).Trim()
$lines += (powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>&1 | Out-String).Trim()
$lines += (powercfg /setactive SCHEME_CURRENT 2>&1 | Out-String).Trim()

$lines += "=== lid after ==="
$lines += ((powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION | Out-String).Trim())

$lines | Set-Content -LiteralPath $report -Encoding UTF8
