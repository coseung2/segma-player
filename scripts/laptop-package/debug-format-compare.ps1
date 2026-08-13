$ErrorActionPreference = "Continue"
$tools = "C:\Users\malla\AppData\Local\AuraDownloader\youtube\tools"
$service = "C:\Users\malla\AppData\Local\Aura YouTube"
$work = Join-Path $service "work"
$stamp = [DateTime]::Now.Ticks

function Run-Timed($label, $cmdArgs) {
  $stdout = Join-Path $work "cmp-$label-out-$stamp.txt"
  $stderr = Join-Path $work "cmp-$label-err-$stamp.txt"
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  & (Join-Path $tools "yt-dlp.exe") @cmdArgs 2> $stderr 1> $stdout
  $watch.Stop()
  $errText = Get-Content $stderr -ErrorAction SilentlyContinue | Select-Object -Last 3
  $files = Get-ChildItem $work -Filter "cmp-$label-*" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "out-|err-" }
  $size = ($files | Measure-Object -Property Length -Sum).Sum
  Write-Output ("$label seconds=" + [math]::Round($watch.Elapsed.TotalSeconds, 1) + " sizeMB=" + [math]::Round($size / 1MB, 1))
  if ($errText) { Write-Output ("$label stderr: " + ($errText -join " | ")) }
  Get-ChildItem $work -Filter "cmp-$label-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

$common = @(
  "--no-playlist", "--no-warnings", "--newline", "--progress",
  "--js-runtimes", "node:C:\Program Files\nodejs\node.exe",
  "--ffmpeg-location", (Join-Path $tools "ffmpeg"),
  "--cookies", (Join-Path $service "cookies.txt"),
  "https://www.youtube.com/watch?v=--sgEQXAC4c"
)

$serverStyle = @(
  "--merge-output-format", "mp4",
  "--print", "after_move:%(title)s",
  "-f", "b/bv*+ba",
  "-o", (Join-Path $work "cmp-server-%(ext)s")
) + $common
Run-Timed "server" $serverStyle

$companionStyle = @(
  "--windows-filenames",
  "--merge-output-format", "mp4",
  "--paths", "home:" + (Join-Path $env:USERPROFILE "Downloads\AuraMediaCmp"),
  "--output", "[%(height)sp] %(title).170B [%(id)s].%(ext)s",
  "--print", "before_dl:AURA_TITLE:%(title)s"
) + $common
Run-Timed "companion" $companionStyle
