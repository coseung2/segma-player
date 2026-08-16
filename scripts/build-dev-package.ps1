[CmdletBinding()]
param(
  [ValidateSet('free', 'pro')]
  [string]$Edition = 'free',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoVersion = if ($Version) {
  $Version
} else {
  (Get-Content -LiteralPath (Join-Path $ProjectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
$archiveName = if ($Edition -eq 'pro') {
  "aura-media-downloader-pro-$repoVersion.zip"
} else {
  "aura-media-downloader-$repoVersion.zip"
}
$stagingRoot = Join-Path $ProjectRoot 'artifacts\chrome-web-store'
$stagingDirectory = Join-Path $stagingRoot $(if ($Edition -eq 'pro') { 'staging-pro' } else { 'staging' })

$tempRoot = Join-Path $env:TEMP ("aura-dev-pkg-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
  # 1) Build the store-clean package (audited manifest, whitelisted files).
  $storeOut = Join-Path $tempRoot 'store'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-store-package.ps1') `
    -OutputDirectory $storeOut -Edition $Edition -Version $repoVersion | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Store package build failed.' }

  # 2) Unpack and add the dev-only playback popup surface.
  $storeZip = Join-Path $storeOut $archiveName
  if (-not (Test-Path -LiteralPath $storeZip -PathType Leaf)) {
    throw "Store package not found: $storeZip"
  }
  $stage = Join-Path $tempRoot 'stage'
  Expand-Archive -LiteralPath $storeZip -DestinationPath $stage

  foreach ($relative in @(
    'popup-play.html',
    'playback-addon.js',
    'contextual-hls-loader.js',
    'collection.js',
    'player.html',
    'player.js',
    'player-subtitle.js',
    'subtitle-generation.js',
    'subtitle-folder.html',
    'subtitle-folder.js',
    'vendor/hls.min.mjs'
  )) {
    $source = Join-Path $ProjectRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Dev package file missing: $relative"
    }
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }

  $manifestPath = Join-Path $stage 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $manifest.action.default_popup = 'popup-play.html'
  $permissions = @($manifest.permissions)
  if ($permissions -notcontains 'bookmarks') {
    $manifest.permissions = @($permissions + 'bookmarks' | Sort-Object)
  }
  [System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 12),
    (New-Object System.Text.UTF8Encoding($false)))

  # 3) Re-zip deterministically into site/downloads (what the site serves).
  $outputZip = Join-Path $ProjectRoot "site\downloads\$archiveName"
  Add-Type -AssemblyName System.IO.Compression
  $fileStream = [System.IO.File]::Create($outputZip)
  $archive = [System.IO.Compression.ZipArchive]::new(
    $fileStream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false)
  $fixedTime = [DateTimeOffset]::Parse('1980-01-01T00:00:00+00:00')
  try {
    $prefix = $stage.TrimEnd('\') + '\'
    $files = @(Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object {
      $_.FullName.Substring($prefix.Length).Replace('\', '/')
    } | Sort-Object)
    foreach ($relativePath in $files) {
      $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::NoCompression)
      $entry.LastWriteTime = $fixedTime
      $entryStream = $entry.Open()
      try {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $stage ($relativePath.Replace('/', '\'))))
        $entryStream.Write($bytes, 0, $bytes.Length)
      } finally {
        $entryStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
    $fileStream.Dispose()
  }

  $projectPrefix = $ProjectRoot.TrimEnd('\') + '\'
  $resolvedStagingDirectory = [System.IO.Path]::GetFullPath($stagingDirectory).TrimEnd('\')
  if (-not $resolvedStagingDirectory.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a staging directory outside the project: $resolvedStagingDirectory"
  }
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
  if (Test-Path -LiteralPath $resolvedStagingDirectory) {
    Remove-Item -LiteralPath $resolvedStagingDirectory -Recurse -Force
  }
  Copy-Item -LiteralPath $stage -Destination $resolvedStagingDirectory -Recurse -Force

  Write-Output "DEV_PACKAGE_OK"
  Write-Output "VERSION=$repoVersion"
  Write-Output "EDITION=$Edition"
  Write-Output "ZIP=$outputZip"
  Write-Output "STAGING=$resolvedStagingDirectory"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
