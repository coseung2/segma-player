param(
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [Alias('ExtensionId')]
  [string]$ChromeExtensionId = '',

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$EdgeExtensionId = '',

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [string[]]$AdditionalExtensionId = @(),

  [Parameter(Mandatory = $true)]
  [string]$ToolsDirectory,

  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),
  [string]$SignToolName = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ToolsDirectory = [System.IO.Path]::GetFullPath($ToolsDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$originConfigPath = Join-Path $ProjectRoot 'installer\companion-extension-origins.json'
$originConfig = Get-Content -LiteralPath $originConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($ChromeExtensionId)) {
  $ChromeExtensionId = [string]$originConfig.chromeStoreExtensionId
}
$allowedExtensionIds = @(
  $ChromeExtensionId
  $EdgeExtensionId
  @($originConfig.developmentExtensionIds)
  @($AdditionalExtensionId)
) | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
foreach ($extensionId in $allowedExtensionIds) {
  if ($extensionId -notmatch '^[a-p]{32}$') {
    throw "Invalid Companion extension ID in $originConfigPath`: $extensionId"
  }
}
$AllowedExtensionIds = $allowedExtensionIds -join '|'
$manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$AppVersion = [string]$manifest.version
if ($AppVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "Invalid companion installer version: $AppVersion"
}

if ([string]::IsNullOrWhiteSpace($AllowedExtensionIds)) {
  throw 'At least one Companion extension ID must be configured.'
}

$required = @(
  (Join-Path $ToolsDirectory 'ffmpeg\ffmpeg.exe'),
  (Join-Path $ToolsDirectory 'mpv\mpv.exe'),
  (Join-Path $ToolsDirectory 'yt-dlp.exe'),
  (Join-Path $ToolsDirectory 'node.exe'),
  (Join-Path $ToolsDirectory 'THIRD_PARTY_NOTICES.txt')
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required redistributable companion file is missing: $path"
  }
}
$thirdPartyNotices = Get-Content -LiteralPath (Join-Path $ToolsDirectory 'THIRD_PARTY_NOTICES.txt') -Raw -Encoding UTF8
if ($thirdPartyNotices -notmatch '(?im)^mpv\b') {
  throw 'THIRD_PARTY_NOTICES.txt must include the bundled mpv build and license notice.'
}

# YouTube began requiring a GVS PO token for the android_vr high-quality
# streams that older yt-dlp builds still selected. 2026.08.19 switches the
# tokenless default to a viable client; reject stale redistributable toolsets
# so a new Companion installer cannot silently reintroduce HTTP 403 failures.
$MinimumYtDlpVersion = [version]'2026.8.19'
$ytDlpPath = Join-Path $ToolsDirectory 'yt-dlp.exe'
$ytDlpVersionText = [string](& $ytDlpPath --version 2>&1 | Select-Object -First 1)
# The Windows standalone build can leave PowerShell's LASTEXITCODE at -1 when
# its stdout is captured even though it emitted a valid version. Validate the
# release identifier itself instead of treating that wrapper artifact as a
# failed executable.
if ($ytDlpVersionText.Trim() -notmatch '^\d{4}\.\d{1,2}\.\d{1,2}$') {
  throw "Bundled yt-dlp did not report a valid release version: $ytDlpVersionText"
}
$ytDlpVersion = [version]$ytDlpVersionText.Trim()
if ($ytDlpVersion -lt $MinimumYtDlpVersion) {
  throw "Bundled yt-dlp $ytDlpVersion is too old; Companion requires $MinimumYtDlpVersion or newer."
}

& cargo build --release --manifest-path (Join-Path $ProjectRoot 'native-host\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Native companion release build failed.' }

# The manager window is a separate crate so the native messaging host stays a
# small stdio process with no GUI dependencies. The installer ships both.
& cargo build --release --manifest-path (Join-Path $ProjectRoot 'companion-gui\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Companion manager release build failed.' }

$managerBinary = Join-Path $ProjectRoot 'companion-gui\target\release\aura-media-manager.exe'
if (-not (Test-Path -LiteralPath $managerBinary -PathType Leaf)) {
  throw "Companion manager binary is missing: $managerBinary"
}

$compilerCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$compilerPath = if ($null -ne $compilerCommand) { $compilerCommand.Source } else { '' }
if ([string]::IsNullOrWhiteSpace($compilerPath)) {
  $compilerCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
  )
  foreach ($candidate in $compilerCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $compilerPath = $candidate
      break
    }
  }
}
if ([string]::IsNullOrWhiteSpace($compilerPath)) {
  throw 'Inno Setup 6 or 7 was not found. Install it and retry.'
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$arguments = @(
  "/DToolsDirectory=$ToolsDirectory",
  "/DOutputDirectory=$OutputDirectory",
  "/DAppVersion=$AppVersion",
  "/DAllowedExtensionIds=$AllowedExtensionIds"
)
if (-not [string]::IsNullOrWhiteSpace($SignToolName)) {
  $arguments += "/DSignToolName=$SignToolName"
}
$arguments += (Join-Path $ProjectRoot 'installer\AuraMediaCompanion.iss')

& $compilerPath @arguments
if ($LASTEXITCODE -ne 0) { throw 'Companion installer compilation failed.' }
Write-Output "Companion installer created in $OutputDirectory"
