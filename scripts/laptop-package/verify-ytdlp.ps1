$ErrorActionPreference = 'Stop'
$tools = Join-Path $env:USERPROFILE 'AppData\Local\AuraDownloader\youtube\tools'
$service = Join-Path $env:USERPROFILE 'AppData\Local\Aura YouTube'
$ytDlp = Join-Path $tools 'yt-dlp.exe'
$ffmpeg = Join-Path $tools 'ffmpeg'
$cookies = Join-Path $service 'cookies.txt'

& $ytDlp `
  --ignore-config `
  --simulate `
  --no-playlist `
  --cookies $cookies `
  --js-runtimes "node:C:\Program Files\nodejs\node.exe" `
  --ffmpeg-location $ffmpeg `
  -f 'b/bv*+ba' `
  --print 'id=%(id)s title=%(title)s' `
  'https://www.youtube.com/watch?v=MUsAxbNgM08'

if ($LASTEXITCODE -ne 0) {
  throw "yt-dlp simulation failed with exit code $LASTEXITCODE"
}
