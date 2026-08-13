param(
  [string]$BrowserRoot = "C:\Users\coseung2\AppData\Local\Google\Chrome\User Data",
  [string]$Profile = "Default",
  [switch]$SkipPush
)

$ErrorActionPreference = "Continue"
$repo = "C:\Users\coseung2\Desktop\Projects\aura-mdownloader"
$logPath = Join-Path $repo "artifacts\cookie-sync.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$keyFile = Join-Path $env:TEMP "aura-cookie-key.txt"
$cookiesOut = Join-Path $repo "artifacts\youtube-cookies.txt"
$localState = Join-Path $BrowserRoot "Local State"
$cookiesDb = Join-Path $BrowserRoot "$Profile\Network\Cookies"

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
  $summaryJson = & node (Join-Path $repo "scripts\cdp-export-cookies.mjs") $cookiesOut 2>$null | Select-Object -Last 1
  $summary = $summaryJson | ConvertFrom-Json
  Write-Log "SOURCE cdp"
}
if (-not $summary -or -not $summary.file) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "scripts\chrome-dpapi-key.ps1") `
    -LocalStatePath $localState -KeyOutputPath $keyFile | Out-Null
  if (-not (Test-Path -LiteralPath $keyFile)) {
    Write-Log "FAIL dpapi key extraction"
    exit 3
  }
  $summaryJson = & node (Join-Path $repo "scripts\export-youtube-cookies.mjs") $keyFile $cookiesDb $cookiesOut 2>$null | Select-Object -Last 1
  $summary = $summaryJson | ConvertFrom-Json
  Write-Log "SOURCE db"
}
if (-not $summary -or -not $summary.file) {
  Write-Log "FAIL cookie export"
  exit 4
}
Write-Log ("EXPORT exported=" + $summary.exported + " hasSid=" + $summary.hasSid + " hasLoginInfo=" + $summary.hasLoginInfo)

if (-not $summary.hasSid -and -not $summary.hasLoginInfo) {
  Write-Log "NO_SESSION Chrome에 유튜브 로그인이 없습니다. 이 PC Chrome에서 youtube.com 로그인 후 다시 실행하세요."
  exit 0
}

if ($SkipPush) {
  Write-Log "SKIP_PUSH cookies are fresh locally"
  exit 0
}

$remoteTarget = "C:\Users\malla\AppData\Local\Aura YouTube\cookies.txt"
$push = & scp -o BatchMode=yes -o ConnectTimeout=10 $cookiesOut "bossng2@100.108.2.87:$remoteTarget" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Log ("FAIL scp " + ($push -join " "))
  exit 5
}

$restart = & ssh -o BatchMode=yes -o ConnectTimeout=10 bossng2@100.108.2.87 `
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\malla\Downloads\laptop-restart-task.ps1" 2>&1
if ($LASTEXITCODE -ne 0 -or ($restart -join " ") -notmatch '"ok":true') {
  Write-Log ("FAIL remote restart " + ($restart -join " "))
  exit 6
}

Write-Log "PUSH_OK cookies deployed and service restarted"

$probe = & ssh -o BatchMode=yes -o ConnectTimeout=60 bossng2@100.108.2.87 `
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\malla\Downloads\AuraYouTubePackage\verify-ytdlp.ps1" 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Log "PROBE_OK yt-dlp simulate passed with fresh cookies"
} else {
  Write-Log ("PROBE_FAIL " + (($probe | Select-Object -Last 3) -join " "))
  exit 7
}
