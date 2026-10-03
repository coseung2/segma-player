param(
    [string]$Ffmpeg = (Join-Path $env:LOCALAPPDATA 'Aura Media\Companion\tools\ffmpeg\ffmpeg.exe')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Ffmpeg -PathType Leaf)) { throw 'Provide an existing ffmpeg executable with -Ffmpeg.' }
$manifest = Join-Path $PSScriptRoot '..\..\..\src-tauri\Cargo.toml'
$previousFfmpeg = $env:SEGMA_TEST_FFMPEG
try {
    $env:SEGMA_TEST_FFMPEG = (Resolve-Path -LiteralPath $Ffmpeg).Path
    rtk cargo test --manifest-path $manifest media::tests::native_seek_preview_decodes_short_and_final_frame_requests -- --ignored --exact
    if ($LASTEXITCODE -ne 0) { throw 'Native seek preview regression failed.' }
} finally {
    $env:SEGMA_TEST_FFMPEG = $previousFfmpeg
}
