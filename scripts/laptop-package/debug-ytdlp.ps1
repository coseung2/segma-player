$ErrorActionPreference = "Continue"
$tools = "C:\Users\malla\AppData\Local\AuraDownloader\youtube\tools"
$service = "C:\Users\malla\AppData\Local\Aura YouTube"
$work = Join-Path $service "work"
$out = Join-Path $work "debug-%(ext)s"
$stamp = [DateTime]::Now.Ticks
$err = Join-Path $work "debug-stderr-$stamp.txt"
$stdout = Join-Path $work "debug-stdout-$stamp.txt"
$args = @(
  "--no-playlist", "--no-warnings", "--newline", "--progress", "--print", "after_move:%(title)s",
  "--js-runtimes", "node:C:\Program Files\nodejs\node.exe",
  "-f", "b/bv*+ba",
  "--cookies", (Join-Path $service "cookies.txt"),
  "--ffmpeg-location", (Join-Path $tools "ffmpeg"),
  "-o", $out,
  "https://www.youtube.com/watch?v=--sgEQXAC4c"
)
& (Join-Path $tools "yt-dlp.exe") @args 2> $err 1> $stdout
Write-Output ("exit=" + $LASTEXITCODE)
Write-Output "=== STDERR ==="
Get-Content $err -ErrorAction SilentlyContinue | Select-Object -First 30 | Out-String | Write-Output
Write-Output "=== STDOUT ==="
Get-Content $stdout -ErrorAction SilentlyContinue | Select-Object -First 10 | Out-String | Write-Output
