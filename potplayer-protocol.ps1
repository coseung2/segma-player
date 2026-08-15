param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ProtocolUri
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-QueryValue {
  param([System.Uri]$Uri, [string]$Name)
  $query = $Uri.Query.TrimStart('?')
  foreach ($pair in $query -split '&') {
    if (-not $pair) { continue }
    $parts = $pair -split '=', 2
    $key = [System.Uri]::UnescapeDataString(($parts[0] -replace '\+', ' '))
    if ($key -ne $Name) { continue }
    $value = if ($parts.Count -gt 1) { $parts[1] } else { '' }
    return [System.Uri]::UnescapeDataString(($value -replace '\+', ' '))
  }
  return $null
}

function Find-PotPlayer {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'DAUM\PotPlayer\PotPlayerMini64.exe'),
    (Join-Path ${env:ProgramFiles} 'DAUM\PotPlayer\PotPlayer.exe')
  )
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DAUM\PotPlayer\PotPlayerMini.exe')
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DAUM\PotPlayer\PotPlayer.exe')
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  $command = Get-Command PotPlayerMini64.exe, PotPlayer.exe, PotPlayerMini.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw 'PotPlayer를 찾지 못했습니다. PotPlayer를 먼저 설치해 주세요.'
}

function Normalize-MediaIdentifier {
  param([string]$Value)
  if (-not $Value) { return $null }
  $match = [regex]::Match($Value, '(?i)(?<![A-Z0-9])([A-Z]{2,10})[-_ ]?(\d{2,6})(?!\d)')
  if (-not $match.Success) { return $null }
  return ('{0}-{1}' -f $match.Groups[1].Value.ToUpperInvariant(), $match.Groups[2].Value)
}

function Find-Subtitle {
  param([string]$Title, [string]$MediaUrl)
  $roots = @()
  if ($env:AURA_SUBTITLE_DIR) { $roots += $env:AURA_SUBTITLE_DIR }
  $roots += (Join-Path $env:USERPROFILE 'Downloads\Subtitles')
  $roots += (Join-Path $env:USERPROFILE 'Downloads')

  $identifier = Normalize-MediaIdentifier $Title
  if (-not $identifier) { $identifier = Normalize-MediaIdentifier $MediaUrl }

  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    if ($identifier) {
      $pattern = $identifier -replace '-', '[-_ ]?'
      $subtitle = Get-ChildItem -LiteralPath $root -Filter '*.srt' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match ('(?i)' + $pattern) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
      if ($subtitle) { return $subtitle.FullName }
    }
  }
  return $null
}

$uri = [System.Uri]$ProtocolUri
if ($uri.Scheme -ne 'aura-player' -or $uri.Host -ne 'play') {
  throw '지원하지 않는 Aura Player 요청입니다.'
}

$mediaUrl = Get-QueryValue $uri 'url'
$title = Get-QueryValue $uri 'title'
if (-not $mediaUrl) { throw '재생할 미디어 URL이 없습니다.' }
$media = [System.Uri]$mediaUrl
if ($media.Scheme -notin @('http', 'https')) { throw 'http(s) 미디어 URL만 재생할 수 있습니다.' }

$potPlayer = Find-PotPlayer
$subtitle = Find-Subtitle $title $mediaUrl
$arguments = @('"' + $mediaUrl.Replace('"', '\"') + '"')
if ($subtitle) { $arguments += ('/sub="' + $subtitle.Replace('"', '\"') + '"') }

Start-Process -FilePath $potPlayer -ArgumentList $arguments | Out-Null
