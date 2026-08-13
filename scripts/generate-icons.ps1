param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\icons')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$masterSize = 1024
$master = New-Object System.Drawing.Bitmap($masterSize, $masterSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($master)
try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $bounds = New-Object System.Drawing.RectangleF(32, 32, 960, 960)
  $radius = 224.0
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  try {
    $diameter = $radius * 2
    $path.AddArc($bounds.Left, $bounds.Top, $diameter, $diameter, 180, 90)
    $path.AddArc($bounds.Right - $diameter, $bounds.Top, $diameter, $diameter, 270, 90)
    $path.AddArc($bounds.Right - $diameter, $bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($bounds.Left, $bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $surface = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bounds, [System.Drawing.ColorTranslator]::FromHtml('#243956'), [System.Drawing.ColorTranslator]::FromHtml('#101722'), 45)
    try { $graphics.FillPath($surface, $path) } finally { $surface.Dispose() }
  } finally { $path.Dispose() }

  $aura = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#68A2F4'), 76)
  $aura.StartCap = $aura.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  try { $graphics.DrawEllipse($aura, 228, 192, 568, 568) } finally { $aura.Dispose() }

  $arrow = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#F4F8FF'), 92)
  $arrow.StartCap = $arrow.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $arrow.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  try {
    $graphics.DrawLine($arrow, 512, 260, 512, 608)
    $graphics.DrawLines($arrow, [System.Drawing.Point[]]@(
      (New-Object System.Drawing.Point(368, 484)),
      (New-Object System.Drawing.Point(512, 628)),
      (New-Object System.Drawing.Point(656, 484))
    ))
    $graphics.DrawLine($arrow, 348, 748, 676, 748)
  } finally { $arrow.Dispose() }
} finally {
  $graphics.Dispose()
}

try {
  foreach ($size in @(16, 32, 48, 128)) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $target = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $target.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $target.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $target.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $drawSize = if ($size -eq 128) { 96 } else { $size }
      $offset = [int](($size - $drawSize) / 2)
      $target.DrawImage($master, $offset, $offset, $drawSize, $drawSize)
      $bitmap.Save((Join-Path $output "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $target.Dispose()
      $bitmap.Dispose()
    }
  }
} finally {
  $master.Dispose()
}

Write-Output "Generated Aura Media icons in $output"
