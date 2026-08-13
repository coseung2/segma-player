$ErrorActionPreference = "Continue"
$report = "C:\Users\malla\Downloads\aura-lid-report.txt"
$lines = @()

$lines += (powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>&1 | Out-String).Trim()
$lines += (powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1 2>&1 | Out-String).Trim()
$lines += (powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0 2>&1 | Out-String).Trim()
$lines += (powercfg /setactive SCHEME_CURRENT 2>&1 | Out-String).Trim()

try {
  $data = Get-CimInstance -Namespace "root\cimv2\power" -ClassName Win32_PowerSettingDataIndex -ErrorAction Stop |
    Where-Object { $_.InstanceID -match "5ca83367|29f6c1db-86da-48c5-9fdb-f2b67b1f44da" }
  foreach ($item in $data) {
    $scheme = if ($item.InstanceID -match "^Microsoft:PowerSettingDataIndex\{([^}]+)\}") { $matches[1] } else { "?" }
    $acdc = if ($item.InstanceID -match "\\\\(AC|DC)\\\\") { $matches[1] } else { "?" }
    $setting = if ($item.InstanceID -match "\{([0-9a-f-]+)\}$") { $matches[1] } else { "?" }
    $lines += ("power " + $setting + " " + $acdc + "=" + $item.SettingIndexValue + " scheme=" + $scheme.Substring(0, [Math]::Min(8, $scheme.Length)))
  }
} catch {
  $lines += ("cim-error=" + $_.Exception.Message)
}

$lines | Set-Content -LiteralPath $report -Encoding UTF8
