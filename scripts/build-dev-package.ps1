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

$tempRoot = Join-Path $env:TEMP ("aura-dev-pkg-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
  # 1) Build the store-clean package (audited manifest, whitelisted files).
  $storeOut = Join-Path $tempRoot 'store'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-store-package.ps1') `
    -OutputDirectory $storeOut -Edition $Edition -Version $repoVersion | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Store package build failed.' }

  # 2) Unpack and add the PotPlayer dev-only popup surface.
  $storeZip = Join-Path $storeOut $archiveName
  if (-not (Test-Path -LiteralPath $storeZip -PathType Leaf)) {
    throw "Store package not found: $storeZip"
  }
  $stage = Join-Path $tempRoot 'stage'
  Expand-Archive -LiteralPath $storeZip -DestinationPath $stage

  foreach ($relative in @('popup-potplayer.html', 'potplayer-popup-addon.js', 'potplayer-protocol.js')) {
    $source = Join-Path $ProjectRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Dev package file missing: $relative"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage $relative) -Force
  }

  $manifestPath = Join-Path $stage 'manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $manifest.action.default_popup = 'popup-potplayer.html'
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

  Write-Output "DEV_PACKAGE_OK"
  Write-Output "VERSION=$repoVersion"
  Write-Output "EDITION=$Edition"
  Write-Output "ZIP=$outputZip"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
