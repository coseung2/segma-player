Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$protocolRoot = "HKCU:\Software\Classes\aura-player"
if (Test-Path -LiteralPath $protocolRoot) {
  Remove-Item -LiteralPath $protocolRoot -Recurse -Force
}

$installDir = Join-Path $env:LOCALAPPDATA "Aura Media\PotPlayer"
if (Test-Path -LiteralPath $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
}

[Environment]::SetEnvironmentVariable("AURA_SUBTITLE_DIR", $null, "User")
Write-Host "Aura PotPlayer companion removed."
