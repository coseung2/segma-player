$paths = @(
  "C:\Users\malla\AppData\Local\Aura YouTube",
  "C:\Users\malla\AppData\Local\Aura YouTube\app.js",
  "C:\Users\malla\AppData\Local\Aura YouTube\cookies.txt",
  "C:\Users\malla\Downloads\AuraYouTubePackage\cookies.txt"
)
foreach ($p in $paths) {
  $item = Get-Item -LiteralPath $p -ErrorAction SilentlyContinue
  if ($item) {
    Write-Output ("EXISTS " + $p + " | size=" + $item.Length + " | mtime=" + $item.LastWriteTime.ToString("yyyy-MM-dd HH:mm"))
  } else {
    Write-Output ("MISSING " + $p)
  }
}
Write-Output "=== service folder ==="
Get-ChildItem -LiteralPath "C:\Users\malla\AppData\Local\Aura YouTube" -Force -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String | Write-Output
Write-Output "=== task action ==="
$task = Get-ScheduledTask -TaskName "Aura YouTube Service" -ErrorAction SilentlyContinue
if ($task) {
  $task.Actions | ForEach-Object { Write-Output ("EXEC=" + $_.Execute + " ARGS=" + $_.Arguments + " WORKDIR=" + $_.WorkingDirectory) }
} else {
  Write-Output "task-missing"
}
