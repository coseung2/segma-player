param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "artifacts\player-diagnostics"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$resolvedProject = [System.IO.Path]::GetFullPath($projectRoot)
if (-not $resolvedOutput.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must remain inside the project artifacts boundary."
}
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PlayerDumpCapture {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("dbghelp.dll", SetLastError = true)]
    public static extern bool MiniDumpWriteDump(
        IntPtr process,
        uint processId,
        IntPtr file,
        uint dumpType,
        IntPtr exceptionParam,
        IntPtr userStreamParam,
        IntPtr callbackParam);
}
"@

$process = Get-Process -Id $ProcessId
$stamp = [DateTime]::Now.ToString("yyyyMMdd-HHmmss-fff")
$dumpPath = Join-Path $resolvedOutput "aura-media-manager-$ProcessId-$stamp.dmp"
$metaPath = Join-Path $resolvedOutput "aura-media-manager-$ProcessId-$stamp.json"
$queryAndRead = [uint32]0x0410
$handle = [PlayerDumpCapture]::OpenProcess($queryAndRead, $false, [uint32]$ProcessId)
if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$dumped = $false
$lastError = 0
$file = [System.IO.File]::Open($dumpPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
try {
    $dumped = [PlayerDumpCapture]::MiniDumpWriteDump($handle, [uint32]$ProcessId, $file.SafeFileHandle.DangerousGetHandle(), [uint32]2, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
    if (-not $dumped) { $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
} finally {
    $file.Dispose()
    [PlayerDumpCapture]::CloseHandle($handle) | Out-Null
}
[PSCustomObject]@{
    pid = $process.Id
    path = $process.Path
    responding = $process.Responding
    startTime = $process.StartTime.ToUniversalTime().ToString("o")
    capturedAt = [DateTime]::UtcNow.ToString("o")
    dumpPath = if ($dumped) { $dumpPath } else { $null }
    dumpError = if ($dumped) { $null } else { $lastError }
} | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding UTF8
Write-Output "DUMPED=$dumped"
Write-Output "DUMP=$dumpPath"
Write-Output "META=$metaPath"
