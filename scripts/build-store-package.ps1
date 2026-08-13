[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts\chrome-web-store'),
  [string]$UpgradeUrl = '',
  [string]$Version = '',
  [ValidateSet('free', 'pro')]
  [string]$Edition = 'free'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StoreRoot = Join-Path $RepositoryRoot 'store'
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$StageDirectory = Join-Path $OutputDirectory $(if ($Edition -eq 'pro') { 'staging-pro' } else { 'staging' })

if ($OutputDirectory.Equals($RepositoryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to use the repository root as the package output directory.'
}
if (-not (Test-Path -LiteralPath $StoreRoot -PathType Container)) {
  throw "Store source directory is missing: $StoreRoot"
}

$SourceManifestPath = Join-Path $RepositoryRoot 'manifest.json'
$AuditedManifestPath = Join-Path $StoreRoot 'manifest.json'
$sourceManifest = Get-Content -LiteralPath $SourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$auditedManifest = Get-Content -LiteralPath $AuditedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$effectiveVersion = if ($Version) { $Version } else { [string]$sourceManifest.version }
if ($effectiveVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "Invalid Chrome Web Store version: $effectiveVersion"
}
if ($UpgradeUrl) {
  $parsedUpgradeUrl = $null
  $validUpgradeUrl = [System.Uri]::TryCreate($UpgradeUrl, [System.UriKind]::Absolute, [ref]$parsedUpgradeUrl)
  if (-not $validUpgradeUrl -or $parsedUpgradeUrl.Scheme -ne 'https' -or $parsedUpgradeUrl.UserInfo) {
    throw 'Upgrade URL must be an absolute HTTPS URL without embedded credentials.'
  }
}

$runtimeFiles = @(
  'aes-cbc.js',
  'background.js',
  'candidate.js',
  'content.js',
  'download-errors.js',
  'download-job-view.js',
  'download-jobs.js',
  'download-scheduler.js',
  'download-worker.html',
  'download-worker.js',
  'download.js',
  'hls-download.js',
  'hls.js',
  'level5-key-error.js',
  'level5-page-bridge.js',
  'license.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'media-fetch-lease.js',
  'options.html',
  'options.js',
  'parallel-download.js',
  'player-page-resolver.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'progressive-redirect.js',
  'product-plan.js',
  'save-directory.js',
  'youtube-server.js',
  'edition.js',
  'manifest.json'
)

$forbiddenEntryPatterns = @(
  '(?i)(^|/)(?:bridge|route-client|redirect-block-rules)(?:\.js|\.json)?$',
  '(?i)(?:^|/)(?:.*\.test\.mjs|README\.md|AGENTS\.md)$',
  '(?i)(?:^|/)(?:native-host|scripts|store)/'
)
$forbiddenIdentifiers = @(
  '(?i)personalvpn',
  '(?i)personal-vpn',
  '(?i)com\.personal',
  '(?i)hfpkpbadllkhedocoglbggkpnbaibmcp',
  '(?i)wherewindsmeet',
  '(?i)redirect-block-rules',
  '(?i)route-client',
  '(?i)MEDIA_ROUTE_NATIVE_HOST'
)

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Read-Utf8([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}

function Copy-RuntimeFile([string]$RelativePath) {
  $source = Join-Path $RepositoryRoot $RelativePath
  $destination = Join-Path $StageDirectory $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Whitelisted runtime file is missing: $RelativePath"
  }
  New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Replace-StoreOnlyPrivateBridge([string]$RelativePath) {
  if ([System.IO.Path]::GetExtension($RelativePath) -notin @('.js', '.html', '.css', '.json')) { return }
  $path = Join-Path $StageDirectory $RelativePath
  $text = Read-Utf8 $path

  if ($RelativePath -eq 'level5-page-bridge.js') {
    $text = $text -replace '(?m)^  let decoderPromise = null;\r?\n', ''
    $text = [regex]::Replace(
      $text,
      '(?s)\r?\n  function inlineAssetUrl\(property, fallbackPath\) \{.*?\r?\n  \}\r?\n',
      ''
    )
    $text = [regex]::Replace(
      $text,
      '(?s)\r?\n  async function level5Decoder\(\) \{.*?\r?\n  \}\r?\n',
      ''
    )
    $text = [regex]::Replace(
      $text,
      '(?s)\r?\n  async function decodeRuntimeKey\(url\) \{.*?\r?\n  \}\r?\n',
      ''
    )
      $text = [regex]::Replace(
        $text,
        '(?s)    let failure = "level5-key-unavailable";\r?\n    try \{\r?\n      const key = await decodeRuntimeKey\(url\.href\);.*?Older Level5 builds may not expose the runtime assets used by current players\.\r?\n    \}\r?\n',
        '    let failure = "level5-key-unavailable";' + [System.Environment]::NewLine
      )
  }

  # Normalize legacy local-only labels in staged runtime code. This does not
  # alter the development checkout or any native companion source.
  $text = $text.Replace('personal-vpn', 'aura-media').Replace('personalVpn', 'auraMedia').Replace('Personal VPN', 'Aura Media')

  Write-Utf8NoBom $path $text
}

function Write-AuditedManifest {
  $requiredPermissions = @(
    'activeTab', 'contextMenus', 'declarativeNetRequest',
    'downloads', 'offscreen', 'scripting', 'storage', 'webRequest'
  )
  if ($auditedManifest.manifest_version -ne 3) { throw 'Store manifest must be Manifest V3.' }
  if ($auditedManifest.PSObject.Properties.Name -contains 'key') { throw 'Store manifest must not contain a fixed key.' }
  if ($auditedManifest.PSObject.Properties.Name -contains 'declarative_net_request') {
    throw 'Store manifest must not contain a static site-specific redirect rule.'
  }
  if ($auditedManifest.name -ne 'Aura Media Downloader') { throw 'Store manifest branding is not Aura Media.' }
  $manifestPermissions = (@($auditedManifest.permissions) | Sort-Object) -join ','
  $minimumPermissions = ($requiredPermissions | Sort-Object) -join ','
  if ($manifestPermissions -ne $minimumPermissions) {
    throw 'Store manifest permissions differ from the audited current-runtime minimum.'
  }
  $manifestHosts = (@($auditedManifest.host_permissions) | Sort-Object) -join ','
  if ($manifestHosts -ne 'http://*/*,https://*/*') {
    throw 'Store manifest host permissions must cover the current webRequest runtime.'
  }
  $contentScripts = @($auditedManifest.content_scripts)
  if ($contentScripts.Count -ne 2) {
    throw 'Store manifest must expose exactly the bundled page bridge and isolated content detector.'
  }
  $mainBridge = $contentScripts[0]
  $isolatedContent = $contentScripts[1]
  $mainProperties = (@($mainBridge.PSObject.Properties.Name) | Sort-Object) -join ','
  $isolatedProperties = (@($isolatedContent.PSObject.Properties.Name) | Sort-Object) -join ','
  $validMainBridge = $mainProperties -eq 'all_frames,js,matches,run_at,world' -and
    (@($mainBridge.matches) -join ',') -eq 'http://*/*,https://*/*' -and
    (@($mainBridge.js) -join ',') -eq 'level5-page-bridge.js' -and
    $mainBridge.run_at -eq 'document_start' -and
    $mainBridge.all_frames -eq $true -and
    $mainBridge.world -eq 'MAIN'
  if (-not $validMainBridge) {
    throw 'Store manifest MAIN content script must be the document_start page bridge.'
  }
  $validIsolatedContent = $isolatedProperties -eq 'all_frames,js,matches,run_at' -and
    (@($isolatedContent.matches) -join ',') -eq 'http://*/*,https://*/*' -and
    (@($isolatedContent.js) -join ',') -eq 'content.js' -and
    $isolatedContent.run_at -eq 'document_idle' -and
    $isolatedContent.all_frames -eq $true
  if (-not $validIsolatedContent) {
    throw 'Store manifest isolated content script must be content.js at document_idle.'
  }
  if ($auditedManifest.background.service_worker -ne 'background.js' -or $auditedManifest.background.type -ne 'module') {
    throw 'Store manifest background runtime is not the audited module worker.'
  }

  $auditedManifest.version = $effectiveVersion
  $manifestText = $auditedManifest | ConvertTo-Json -Depth 12
  Write-Utf8NoBom (Join-Path $StageDirectory 'manifest.json') $manifestText
}

function Write-Edition {
  $upgradeLiteral = $UpgradeUrl | ConvertTo-Json -Compress
  $edition = if ($Edition -eq 'pro') {
    @"
// Generated by scripts/build-store-package.ps1 (Pro test build). Do not ship to the store.
export const PRODUCT_EDITION = "pro";
export const UPGRADE_URL = $upgradeLiteral;
"@
  } else {
    @"
// Generated by scripts/build-store-package.ps1. Do not edit the staged copy.
export const PRODUCT_EDITION = "free";
export const UPGRADE_URL = $upgradeLiteral;
"@
  }
  Write-Utf8NoBom (Join-Path $StageDirectory 'edition.js') $edition

  $sourcePlan = Join-Path $RepositoryRoot 'product-plan.js'
  if (-not (Test-Path -LiteralPath $sourcePlan -PathType Leaf)) { throw 'product-plan.js is required for store packaging.' }
  Copy-Item -LiteralPath $sourcePlan -Destination (Join-Path $StageDirectory 'product-plan.js') -Force
}

function Get-StageRelativeFiles {
  $prefix = $StageDirectory.TrimEnd('\') + '\'
  return @(Get-ChildItem -LiteralPath $StageDirectory -File -Recurse | ForEach-Object {
    $_.FullName.Substring($prefix.Length).Replace('\', '/')
  } | Sort-Object)
}

function Invoke-StoreAudit([string[]]$ExpectedFiles) {
  $actualFiles = Get-StageRelativeFiles
  $differences = Compare-Object -ReferenceObject ($ExpectedFiles | Sort-Object) -DifferenceObject $actualFiles
  if ($differences) { throw "Staged files differ from the explicit runtime allowlist: $($differences | Out-String)" }

  foreach ($entry in $actualFiles) {
    foreach ($pattern in $forbiddenEntryPatterns) {
      if ($entry -match $pattern) { throw "Forbidden store artifact entry: $entry" }
    }
    if ([System.IO.Path]::GetExtension($entry) -in @('.js', '.html', '.css', '.json')) {
      $text = Read-Utf8 (Join-Path $StageDirectory ($entry.Replace('/', '\')))
      foreach ($pattern in $forbiddenIdentifiers) {
        if ($text -match $pattern) { throw "Forbidden store identifier '$pattern' found in $entry" }
      }
    }
  }

  $manifest = Get-Content -LiteralPath (Join-Path $StageDirectory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.PSObject.Properties.Name -contains 'key') { throw 'Store audit found a fixed manifest key.' }
  if ($manifest.PSObject.Properties.Name -contains 'declarative_net_request') { throw 'Store audit found a static DNR rule.' }
  $contentScripts = @($manifest.content_scripts)
  $validContentScripts = $contentScripts.Count -eq 2 -and
    (@($contentScripts[0].js) -join ',') -eq 'level5-page-bridge.js' -and
    $contentScripts[0].run_at -eq 'document_start' -and
    $contentScripts[0].world -eq 'MAIN' -and
    (@($contentScripts[1].js) -join ',') -eq 'content.js' -and
    $contentScripts[1].run_at -eq 'document_idle' -and
    -not ($contentScripts[1].PSObject.Properties.Name -contains 'world')
  if (-not $validContentScripts) {
    throw 'Store audit found content scripts other than the exact bundled bridge and isolated detector.'
  }
  $bridge = Read-Utf8 (Join-Path $StageDirectory 'level5-page-bridge.js')
  if ($bridge -match '(?i)\bimport\s*\(|\bWebAssembly\b|\bwasm\b|/assets/|inlineAssetUrl|level5Decoder|decodeRuntimeKey|document\.scripts') {
    throw 'Store audit found remote runtime discovery, dynamic import, runtime decode, or WASM in the bundled page bridge.'
  }
  if ($bridge -notmatch 'cachedKey\(hls, url\.href\)' -or $bridge -notmatch 'loadKey\(hls, url\.href\)') {
    throw 'Store audit did not find the bundled page bridge cache and loader key paths.'
  }
  $auditedBackground = Read-Utf8 (Join-Path $StageDirectory 'background.js')
  if ($auditedBackground -match 'connectNative|com\.aura\.media_companion|native-file-writer') {
    throw 'Store audit found a native companion dependency in the background runtime.'
  }
}

function Write-DeterministicZip([string[]]$Files, [string]$Path) {
  Add-Type -AssemblyName System.IO.Compression
  $fileStream = [System.IO.File]::Create($Path)
  $archive = [System.IO.Compression.ZipArchive]::new(
    $fileStream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  $fixedTime = [DateTimeOffset]::Parse('1980-01-01T00:00:00+00:00')
  try {
    foreach ($relativePath in ($Files | Sort-Object)) {
      $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::NoCompression)
      $entry.LastWriteTime = $fixedTime
      $entryStream = $entry.Open()
      try {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $StageDirectory ($relativePath.Replace('/', '\'))))
        $entryStream.Write($bytes, 0, $bytes.Length)
      } finally {
        $entryStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
    $fileStream.Dispose()
  }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $StageDirectory) { Remove-Item -LiteralPath $StageDirectory -Recurse -Force }
New-Item -ItemType Directory -Path $StageDirectory -Force | Out-Null

foreach ($runtimeFile in ($runtimeFiles | Where-Object { $_ -notin @('manifest.json', 'edition.js', 'product-plan.js') })) {
  Copy-RuntimeFile $runtimeFile
}
New-Item -ItemType Directory -Path $StageDirectory -Force | Out-Null
Write-Edition
Write-AuditedManifest

foreach ($runtimeFile in $runtimeFiles) {
  Replace-StoreOnlyPrivateBridge $runtimeFile
}

$expectedFiles = @($runtimeFiles | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
Invoke-StoreAudit $expectedFiles

$packageSuffix = if ($Edition -eq 'pro') { '-pro' } else { '' }
$zipPath = Join-Path $OutputDirectory "aura-media-downloader$packageSuffix-$effectiveVersion.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Write-DeterministicZip $expectedFiles $zipPath

Write-Output 'STORE_PACKAGE_OK'
Write-Output "VERSION=$effectiveVersion"
Write-Output "EDITION=$Edition"
Write-Output "FILES=$($expectedFiles.Count)"
Write-Output "ZIP=$zipPath"
if ($Edition -eq 'free' -and -not $UpgradeUrl) {
  Write-Output 'WARNING=Upgrade URL is empty; the Pro link will remain disabled.'
}
