param(
  [string]$ProtocolUri,
  [switch]$SelfTest
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

# The registry handler runs under Windows PowerShell 5.1, but the helpers are
# also exercised from pwsh during tests. Resolve the system ANSI codepage
# (CP949 on Korean Windows) explicitly so both hosts decode legacy subtitles
# identically. .NET Core requires CodePagesEncodingProvider registration.
function Get-AnsiEncoding {
  try {
    [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
  } catch {
    # Windows PowerShell 5.1 ships code pages natively; registration type absent.
  }
  return [System.Text.Encoding]::GetEncoding(
    [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage)
}

function Get-HangulCount {
  param([string]$Text)
  $count = 0
  foreach ($char in $Text.ToCharArray()) {
    if ($char -ge [char]0xAC00 -and $char -le [char]0xD7A3) { $count++ }
  }
  return $count
}

# PotPlayer auto-detects most encodings, but BOM-less UTF-8 and CJK legacy
# encodings are frequently misread depending on the system locale. Re-encode the
# matched subtitle as UTF-8 with BOM into a temp copy so the same .srt always
# renders correctly, regardless of the user's locale or PotPlayer defaults.
function Prepare-Subtitle {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = $null
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
      $text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
      $text = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    } else {
      # No BOM: most CJK legacy (CP949/EUC-KR) byte pairs decode as *valid* but
      # wrong UTF-8, so neither replacement-character sniffing nor strict
      # validation can distinguish them. On CJK ANSI codepages, compare how many
      # Hangul syllables each candidate decoding produces and prefer the one
      # that actually reads like Korean; otherwise strict UTF-8 wins.
      $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
      $utf8Text = $null
      try {
        $utf8Text = $strictUtf8.GetString($bytes)
      } catch {
      }
      $ansi = Get-AnsiEncoding
      if ($null -eq $utf8Text) {
        $text = $ansi.GetString($bytes)
      } elseif ($ansi.CodePage -in @(932, 936, 949, 950)) {
        $ansiText = $ansi.GetString($bytes)
        if ((Get-HangulCount $ansiText) -gt (Get-HangulCount $utf8Text)) {
          $text = $ansiText
        } else {
          $text = $utf8Text
        }
      } else {
        $text = $utf8Text
      }
    }
    if ($null -eq $text) { return $null }
    $tempDir = Join-Path $env:TEMP 'Aura Media Subtitles'
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $tempFile = Join-Path $tempDir ([System.IO.Path]::GetFileNameWithoutExtension($Path) + '.srt')
    $encoded = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($tempFile, $text, $encoded)
    return $tempFile
  } catch {
    return $null
  }
}

if ($SelfTest) {
  # Test harness: expose helpers for `node --test` without launching PotPlayer.
  return
}

if (-not $ProtocolUri) { throw '재생할 요청 URI가 없습니다.' }
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
$subtitle = Prepare-Subtitle (Find-Subtitle $title $mediaUrl)
$arguments = @('"' + $mediaUrl.Replace('"', '\"') + '"')
if ($subtitle) { $arguments += ('/sub="' + $subtitle.Replace('"', '\"') + '"') }

Start-Process -FilePath $potPlayer -ArgumentList $arguments | Out-Null
