param(
    [int]$PollMilliseconds = 100,
    [int]$GraceMilliseconds = 500,
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
public static class PlayerHangDump {
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

$processName = "aura-media-manager"
$fullAccess = [uint32]0x001F0FFF
$dumpType = [uint32]2
$seen = @{}
Write-Output "MONITOR_READY output=$resolvedOutput"

while ($true) {
    $processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        if (-not $seen.ContainsKey($process.Id)) {
            $seen[$process.Id] = [DateTime]::UtcNow
        }
        if (-not $process.Responding) {
            $unresponsiveSince = $seen[$process.Id]
            if (([DateTime]::UtcNow - $unresponsiveSince).TotalMilliseconds -ge $GraceMilliseconds) {
                $stamp = [DateTime]::Now.ToString("yyyyMMdd-HHmmss-fff")
                $dumpPath = Join-Path $resolvedOutput "aura-media-manager-$($process.Id)-$stamp.dmp"
                $metaPath = Join-Path $resolvedOutput "aura-media-manager-$($process.Id)-$stamp.json"
                $handle = [PlayerHangDump]::OpenProcess($fullAccess, $false, [uint32]$process.Id)
                $dumped = $false
                $lastError = 0
                if ($handle -ne [IntPtr]::Zero) {
                    $file = [System.IO.File]::Open($dumpPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
                    try {
                        $dumped = [PlayerHangDump]::MiniDumpWriteDump($handle, [uint32]$process.Id, $file.SafeFileHandle.DangerousGetHandle(), $dumpType, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
                        if (-not $dumped) { $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
                    } finally {
                        $file.Dispose()
                        [PlayerHangDump]::CloseHandle($handle) | Out-Null
                    }
                } else {
                    $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                }
                [PSCustomObject]@{
                    pid = $process.Id
                    path = $process.Path
                    startTime = $process.StartTime.ToUniversalTime().ToString("o")
                    responding = $process.Responding
                    dumpPath = if ($dumped) { $dumpPath } else { $null }
                    dumpError = if ($dumped) { $null } else { $lastError }
                    capturedAt = [DateTime]::UtcNow.ToString("o")
                } | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding UTF8
                Write-Output "HANG_CAPTURED pid=$($process.Id) dumped=$dumped metadata=$metaPath"
                $seen[$process.Id] = [DateTime]::MaxValue
            }
        } else {
            $seen[$process.Id] = [DateTime]::UtcNow
        }
    }
    Start-Sleep -Milliseconds $PollMilliseconds
}
