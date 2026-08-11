param(
  [string]$PortableZip = ""
)

$ErrorActionPreference = "Stop"
$HostName = "com.aura.youtube_downloader"
$ExtensionId = "hfpkpbadllkhedocoglbggkpnbaibmcp"
$InstallRoot = Join-Path $env:LOCALAPPDATA "AuraDownloader\youtube"
$ToolsRoot = Join-Path $InstallRoot "tools"
$ManifestPath = Join-Path $InstallRoot "$HostName.json"
$ProjectRoot = $PSScriptRoot
$BuiltHost = Join-Path $ProjectRoot "native-host\target\release\aura-youtube-host.exe"

if ([string]::IsNullOrWhiteSpace($PortableZip)) {
  $candidateZip = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE "Downloads") -Filter "*Video*Downloader*Portable*.zip" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $candidateZip) {
    throw "Portable video downloader ZIP was not found in Downloads. Pass -PortableZip explicitly."
  }
  $PortableZip = $candidateZip.FullName
}

if (-not (Test-Path -LiteralPath $PortableZip -PathType Leaf)) {
  throw "Portable ZIP not found: $PortableZip"
}

& cargo build --release --manifest-path (Join-Path $ProjectRoot "native-host\Cargo.toml")
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
  throw "Native host build failed."
}

New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination (Join-Path $InstallRoot "aura-youtube-host.exe") -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($PortableZip)
try {
  foreach ($entry in $archive.Entries) {
    $marker = "/tools/"
    $markerIndex = $entry.FullName.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
    if ($markerIndex -lt 0 -or -not $entry.Name) { continue }
    $relativePath = $entry.FullName.Substring($markerIndex + $marker.Length).Replace("/", "\")
    $destination = Join-Path $ToolsRoot $relativePath
    $resolvedToolsRoot = [System.IO.Path]::GetFullPath($ToolsRoot + "\")
    $resolvedDestination = [System.IO.Path]::GetFullPath($destination)
    if (-not $resolvedDestination.StartsWith($resolvedToolsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Unsafe ZIP path: $($entry.FullName)"
    }
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
  }
} finally {
  $archive.Dispose()
}

$manifest = [ordered]@{
  name = $HostName
  description = "Aura YouTube downloader native host"
  path = (Join-Path $InstallRoot "aura-youtube-host.exe")
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, $utf8NoBom)
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $ManifestPath

Write-Output "Installed $HostName"
Write-Output "Manifest: $ManifestPath"
Write-Output "Tools: $ToolsRoot"
