$ErrorActionPreference = "Continue"
$tools = "C:\Users\malla\AppData\Local\AuraDownloader\youtube\tools"
$service = "C:\Users\malla\AppData\Local\Aura YouTube"
$out = Join-Path (Join-Path $service "work") "formats-$([DateTime]::Now.Ticks).txt"
& (Join-Path $tools "yt-dlp.exe") --no-playlist --no-warnings --js-runtimes "node:C:\Program Files\nodejs\node.exe" --cookies (Join-Path $service "cookies.txt") -F "https://www.youtube.com/watch?v=--sgEQXAC4c" 2>&1 | Select-String -Pattern "mp4|m4a|webm" | Select-Object -First 25 | Out-String | Write-Output
