param(
  [string]$BrowserRoot = "C:\Users\malla\aura-yt-chrome",
  [string]$Profile = "Default",
  [switch]$SkipPush
)

$ErrorActionPreference = "Continue"
$homeDir = "C:\Users\malla"
$scriptsDir = Join-Path $homeDir "Downloads"
$serviceDir = Join-Path $homeDir "AppData\Local\Aura YouTube"
$logPath = Join-Path $serviceDir "cookie-sync.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$keyFile = Join-Path $env:TEMP "aura-cookie-key.txt"
$cookiesOut = Join-Path $serviceDir "cookies-incoming.txt"
$cookiesFinal = Join-Path $serviceDir "cookies.txt"
$localState = Join-Path $BrowserRoot "Local State"
$cookiesDb = Join-Path $BrowserRoot "$Profile\Network\Cookies"
$node = if (Test-Path "C:\Program Files\nodejs\node.exe") { "C:\Program Files\nodejs\node.exe" } else { "node" }

function Write-Log($message) {
  $line = "$stamp $message"
  Write-Output $line
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $localState) -or -not (Test-Path -LiteralPath $cookiesDb)) {
  Write-Log "FAIL missing browser files (localState=$(Test-Path $localState), db=$(Test-Path $cookiesDb))"
  exit 2
}

$summary = $null
$cdpProbe = try { (Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
if ($cdpProbe) {
  $summaryJson = & $node (Join-Path $scriptsDir "cdp-export-cookies.mjs") $cookiesOut 2>$null | Select-Object -Last 1
  $summary = $summaryJson | ConvertFrom-Json
  Write-Log "SOURCE cdp"
}
if (-not $summary -or -not $summary.file) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsDir "chrome-dpapi-key.ps1") `
    -LocalStatePath $localState -KeyOutputPath $keyFile | Out-Null
  if (-not (Test-Path -LiteralPath $keyFile)) {
    Write-Log "FAIL dpapi key extraction"
    exit 3
  }
  $summaryJson = & $node (Join-Path $scriptsDir "export-youtube-cookies.mjs") $keyFile $cookiesDb $cookiesOut 2>$null | Select-Object -Last 1
  $summary = $summaryJson | ConvertFrom-Json
  Write-Log "SOURCE db"
}
if (-not $summary -or -not $summary.file) {
  Write-Log "FAIL cookie export"
  exit 4
}
Write-Log ("EXPORT exported=" + $summary.exported + " hasSid=" + $summary.hasSid + " hasLoginInfo=" + $summary.hasLoginInfo)

if (-not $summary.hasSid -and -not $summary.hasLoginInfo) {
  Write-Log "NO_SESSION 노트북 Chrome(aura-yt-chrome 프로필)에 유튜브 로그인이 없습니다. youtube.com 로그인 후 다시 실행하세요."
  exit 0
}

if ($SkipPush) {
  Write-Log "SKIP_PUSH cookies are fresh locally"
  exit 0
}

Copy-Item -LiteralPath $cookiesOut -Destination $cookiesFinal -Force
Write-Log "PUSH_OK cookies copied to service dir"

$restart = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsDir "laptop-restart-task.ps1") 2>&1
if ($LASTEXITCODE -ne 0 -or ($restart -join " ") -notmatch '"ok":true') {
  Write-Log ("FAIL restart " + ($restart -join " "))
  exit 6
}

Write-Log "RESTART_OK youtube service restarted"

$probe = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsDir "AuraYouTubePackage\verify-ytdlp.ps1") 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Log "PROBE_OK yt-dlp simulate passed with fresh cookies"
} else {
  Write-Log ("PROBE_FAIL " + ($probe -join " "))
  exit 7
}
Write-Log "DONE"
