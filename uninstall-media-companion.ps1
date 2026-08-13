param(
  [ValidateSet('Chrome', 'Edge', 'Both')]
  [string]$Browser = 'Both'
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.aura.media_companion'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Aura Media\Companion'
$registryPaths = @()
if ($Browser -in @('Chrome', 'Both')) {
  $registryPaths += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
}
if ($Browser -in @('Edge', 'Both')) {
  $registryPaths += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
}
foreach ($registryPath in $registryPaths) {
  if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Force
  }
}
if (Test-Path -LiteralPath $InstallRoot) {
  $resolved = [System.IO.Path]::GetFullPath($InstallRoot)
  $expected = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Aura Media\Companion'))
  if (-not $resolved.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected path: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output 'Aura Media Companion removed.'
