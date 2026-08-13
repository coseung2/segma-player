$ErrorActionPreference = "Continue"

Write-Output "=== identity ==="
Write-Output (whoami)
Write-Output ("profile=" + $env:USERPROFILE)

Write-Output "=== lid action ==="
powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION

Write-Output "=== aura tasks ==="
schtasks /query /fo LIST /v | Select-String -Pattern "TaskName|Status|Task To Run" | Select-String -Pattern "aura|youtube|Aura" -Context 0,2

Write-Output "=== aura services ==="
Get-Service | Where-Object { $_.Name -like "*aura*" -or $_.DisplayName -like "*aura*" -or $_.Name -like "*youtube*" } | Select-Object Name,Status,StartType | Format-Table -AutoSize | Out-String | Write-Output

Write-Output "=== port 8788 ==="
netstat -ano | findstr ":8788"

Write-Output "=== healthz ==="
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:8788/healthz" -UseBasicParsing -TimeoutSec 10
  Write-Output ("healthz=" + $response.StatusCode + " body=" + $response.Content)
} catch {
  Write-Output ("healthz-error=" + $_.Exception.Message)
}

Write-Output "=== downloads ==="
Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "aura|youtube|zip|install" } | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String | Write-Output

Write-Output "=== herdr ==="
Get-Process -Name "herdr" -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | Format-Table -AutoSize | Out-String | Write-Output
$herdrCommand = Get-Command herdr -ErrorAction SilentlyContinue
if ($herdrCommand) {
  Write-Output ("herdr-path=" + $herdrCommand.Source)
  try { Write-Output ((& herdr --help 2>&1 | Out-String).Substring(0, [Math]::Min(1200, (& herdr --help 2>&1 | Out-String).Length))) } catch { Write-Output ("herdr-help-error=" + $_.Exception.Message) }
} else {
  Write-Output "herdr-cli-not-on-path"
}

Write-Output "=== opencodex runtime port ==="
Get-ChildItem -Path "$env:USERPROFILE" -Recurse -Filter "runtime-port.json" -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName
