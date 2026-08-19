param(
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [Alias('ExtensionId')]
  [string]$ChromeExtensionId = '',

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$EdgeExtensionId = '',

  [Parameter(Mandatory = $true)]
  [string]$ToolsDirectory,

  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),
  [string]$SignToolName = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ToolsDirectory = [System.IO.Path]::GetFullPath($ToolsDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

if ([string]::IsNullOrWhiteSpace($ChromeExtensionId) -and [string]::IsNullOrWhiteSpace($EdgeExtensionId)) {
  throw 'At least one ChromeExtensionId or EdgeExtensionId must be supplied.'
}

$required = @(
  (Join-Path $ToolsDirectory 'ffmpeg\ffmpeg.exe'),
  (Join-Path $ToolsDirectory 'yt-dlp.exe'),
  (Join-Path $ToolsDirectory 'node.exe'),
  (Join-Path $ToolsDirectory 'THIRD_PARTY_NOTICES.txt')
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required redistributable companion file is missing: $path"
  }
}

& cargo build --release --manifest-path (Join-Path $ProjectRoot 'native-host\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Native companion release build failed.' }

$compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($null -eq $compiler) {
  $defaultCompiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  if (Test-Path -LiteralPath $defaultCompiler -PathType Leaf) {
    $compiler = Get-Item -LiteralPath $defaultCompiler
  } else {
    throw 'Inno Setup 6 was not found. Install it and retry.'
  }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$arguments = @(
  "/DToolsDirectory=$ToolsDirectory",
  "/DOutputDirectory=$OutputDirectory"
)
if (-not [string]::IsNullOrWhiteSpace($ChromeExtensionId)) {
  $arguments += "/DChromeExtensionId=$ChromeExtensionId"
}
if (-not [string]::IsNullOrWhiteSpace($EdgeExtensionId)) {
  $arguments += "/DEdgeExtensionId=$EdgeExtensionId"
}
if (-not [string]::IsNullOrWhiteSpace($SignToolName)) {
  $arguments += "/DSignToolName=$SignToolName"
}
$arguments += (Join-Path $ProjectRoot 'installer\AuraMediaCompanion.iss')

& $compiler.Source @arguments
if ($LASTEXITCODE -ne 0) { throw 'Companion installer compilation failed.' }
Write-Output "Companion installer created in $OutputDirectory"
