$t = & powercfg /q SCHEME_CURRENT 2>&1 | Out-String
Write-Output ("LEN=" + $t.Length)
Write-Output ($t.Substring(0, [Math]::Min(1200, $t.Length)))
Write-Output "=== cim ==="
try {
  Get-CimInstance -Namespace "root\cimv2\power" -ClassName Win32_PowerSettingDataIndex -ErrorAction Stop |
    Where-Object { $_.InstanceID -match "5ca83367|LIDACTION" } |
    Select-Object InstanceID, ElementName, SettingIndexValue |
    Format-List | Out-String | Write-Output
} catch {
  Write-Output ("cim-error=" + $_.Exception.Message)
}
