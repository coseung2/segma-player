param(
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [Alias('ExtensionId')]
  [string]$ChromeExtensionId = '',

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$EdgeExtensionId = '',

  [Parameter(Mandatory = $true)]
  [string]$ToolsArchive,

  [ValidateSet('Chrome', 'Edge', 'Both')]
  [string]$Browser = 'Both'
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.aura.media_companion'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Aura Media\Companion'
$ToolsRoot = Join-Path $InstallRoot 'tools'
$ManifestPath = Join-Path $InstallRoot "$HostName.json"
$ProjectRoot = $PSScriptRoot
$BuiltHost = Join-Path $ProjectRoot 'native-host\target\release\aura-media-companion.exe'
$InstalledHost = Join-Path $InstallRoot 'aura-media-companion.exe'

if ([string]::IsNullOrWhiteSpace($ChromeExtensionId) -and [string]::IsNullOrWhiteSpace($EdgeExtensionId)) {
  throw 'At least one ChromeExtensionId or EdgeExtensionId must be supplied.'
}
if (-not (Test-Path -LiteralPath $ToolsArchive -PathType Leaf)) {
  throw "Tools archive not found: $ToolsArchive"
}

& cargo build --release --manifest-path (Join-Path $ProjectRoot 'native-host\Cargo.toml')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
  throw 'Native companion build failed.'
}

New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
Copy-Item -LiteralPath $BuiltHost -Destination $InstalledHost -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ToolsArchive))
try {
  foreach ($entry in $archive.Entries) {
    $marker = '/tools/'
    $markerIndex = $entry.FullName.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
    if ($markerIndex -lt 0 -or -not $entry.Name) { continue }
    $relativePath = $entry.FullName.Substring($markerIndex + $marker.Length).Replace('/', '\')
    $destination = Join-Path $ToolsRoot $relativePath
    $resolvedToolsRoot = [System.IO.Path]::GetFullPath($ToolsRoot + '\')
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

$requiredTools = @(
  (Join-Path $ToolsRoot 'ffmpeg\ffmpeg.exe'),
  (Join-Path $ToolsRoot 'yt-dlp.exe'),
  (Join-Path $ToolsRoot 'node.exe')
)
foreach ($tool in $requiredTools) {
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
    throw "Required companion tool is missing: $tool"
  }
}

$allowedOrigins = @()
if (-not [string]::IsNullOrWhiteSpace($ChromeExtensionId)) {
  $allowedOrigins += "chrome-extension://$ChromeExtensionId/"
}
if (-not [string]::IsNullOrWhiteSpace($EdgeExtensionId) -and $EdgeExtensionId -ne $ChromeExtensionId) {
  $allowedOrigins += "chrome-extension://$EdgeExtensionId/"
}
$manifest = [ordered]@{
  name = $HostName
  description = 'Aura Media Companion'
  path = $InstalledHost
  type = 'stdio'
  allowed_origins = $allowedOrigins
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, $utf8NoBom)

$registryPaths = @()
if ($Browser -in @('Chrome', 'Both')) {
  $registryPaths += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
}
if ($Browser -in @('Edge', 'Both')) {
  $registryPaths += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
}
foreach ($registryPath in $registryPaths) {
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $ManifestPath
}

Write-Output "Installed $HostName for $Browser"
Write-Output "Manifest: $ManifestPath"
Write-Output "Companion: $InstalledHost"
