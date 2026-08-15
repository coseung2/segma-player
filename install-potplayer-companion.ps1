param(
  [string]$SubtitleDirectory = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "Aura Media\PotPlayer"
$sourceScript = Join-Path $PSScriptRoot "potplayer-protocol.ps1"
$targetScript = Join-Path $installDir "potplayer-protocol.ps1"

if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
  throw "potplayer-protocol.ps1 not found next to installer."
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath $sourceScript -Destination $targetScript -Force

$protocolRoot = "HKCU:\Software\Classes\aura-player"
New-Item -Path $protocolRoot -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:Aura PotPlayer Protocol"
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null

$commandKey = Join-Path $protocolRoot "shell\open\command"
New-Item -Path $commandKey -Force | Out-Null
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$command = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" "%1"' -f $powershell, $targetScript
Set-Item -Path $commandKey -Value $command

if ($SubtitleDirectory) {
  $resolved = [System.IO.Path]::GetFullPath($SubtitleDirectory)
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "Subtitle directory does not exist: $resolved"
  }
  [Environment]::SetEnvironmentVariable("AURA_SUBTITLE_DIR", $resolved, "User")
  $env:AURA_SUBTITLE_DIR = $resolved
}

Write-Host "Aura PotPlayer companion installed."
Write-Host "Protocol: aura-player://"
if ($env:AURA_SUBTITLE_DIR) {
  Write-Host "Subtitle directory: $env:AURA_SUBTITLE_DIR"
} else {
  Write-Host "Subtitle search: Downloads\Subtitles, then Downloads"
}
