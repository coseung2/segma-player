$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

. (Join-Path $scriptRoot "potplayer-protocol.ps1") -SelfTest

$tempRoot = Join-Path $env:TEMP ("aura-potplayer-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
  $subtitleText = "1`r`n00:00:00,500 --> 00:00:03,000`r`n자막 테스트 123`r`n"

  # 1) UTF-8 with BOM
  $utf8Bom = Join-Path $tempRoot "utf8bom.srt"
  [System.IO.File]::WriteAllText($utf8Bom, [char]0xFEFF + $subtitleText, (New-Object System.Text.UTF8Encoding($false)))
  # 2) UTF-8 without BOM
  $utf8 = Join-Path $tempRoot "utf8.srt"
  [System.IO.File]::WriteAllText($utf8, $subtitleText, (New-Object System.Text.UTF8Encoding($false)))
  # 3) UTF-16LE with BOM
  $utf16 = Join-Path $tempRoot "utf16.srt"
  [System.IO.File]::WriteAllText($utf16, $subtitleText, [System.Text.Encoding]::Unicode)

  # 4) CP949 (EUC-KR) without BOM - most CP949 byte pairs decode as valid but
  #    wrong UTF-8, so this must be detected by the Hangul comparison.
  $cp949 = [System.Text.Encoding]::GetEncoding(949)
  $cp949File = Join-Path $tempRoot "cp949.srt"
  [System.IO.File]::WriteAllBytes($cp949File, $cp949.GetBytes($subtitleText))

  foreach ($source in @($utf8Bom, $utf8, $utf16, $cp949File)) {
    $prepared = Prepare-Subtitle $source
    if (-not $prepared) { throw "Prepare-Subtitle returned null for $source" }
    $bytes = [System.IO.File]::ReadAllBytes($prepared)
    if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
      throw "Prepared subtitle is missing UTF-8 BOM: $prepared"
    }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    if (-not $text.Contains("자막 테스트 123")) {
      throw "Prepared subtitle text was corrupted for $source"
    }
    Write-Output "OK $([System.IO.Path]::GetFileName($source)) -> UTF-8 BOM"
  }

  # 4) Identifier extraction
  $id = Normalize-MediaIdentifier "ABC-123 sample"
  if ($id -ne "ABC-123") { throw "Identifier mismatch: $id" }
  Write-Output "OK Normalize-MediaIdentifier"

  # 5) Companion config drives the subtitle roots and wins over Downloads
  $configDir = Join-Path $tempRoot "config"
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  $configPath = Join-Path $configDir "config.json"
  [System.IO.File]::WriteAllText(
    $configPath,
    '{"subtitleDir": "' + ($configDir.Replace('\', '\\')) + '"}',
    (New-Object System.Text.UTF8Encoding($false)))
  $oldConfig = $env:AURA_COMPANION_CONFIG
  $env:AURA_COMPANION_CONFIG = $configPath
  try {
    $subtitleFile = Join-Path $configDir "ABC-123.srt"
    [System.IO.File]::WriteAllText($subtitleFile, $subtitleText, (New-Object System.Text.UTF8Encoding($false)))
    $found = Find-Subtitle "ABC-123 sample" ""
    if ($found -ne $subtitleFile) { throw "Config subtitle root was not used: $found" }
    Write-Output "OK config subtitle root"
  } finally {
    if ($null -eq $oldConfig) { Remove-Item Env:AURA_COMPANION_CONFIG -ErrorAction SilentlyContinue }
    else { $env:AURA_COMPANION_CONFIG = $oldConfig }
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
