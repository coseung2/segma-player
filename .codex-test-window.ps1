param(
    [Parameter(Mandatory = $true)]
    [Int64]$WindowHandle,
    [ValidateSet('inspect', 'hide-show', 'resize-back', 'composition-window')]
    [string]$Action = 'inspect',
    [string]$CapturePath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SegmaWindowProbe {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
}
'@

$hwnd = [IntPtr]$WindowHandle
$rect = [SegmaWindowProbe+RECT]::new()
[void][SegmaWindowProbe]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

switch ($Action) {
    'hide-show' {
        [void][SegmaWindowProbe]::ShowWindow($hwnd, 0)
        Start-Sleep -Milliseconds 200
        [void][SegmaWindowProbe]::ShowWindow($hwnd, 8)
    }
    'resize-back' {
        [void][SegmaWindowProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, $rect.Left, $rect.Top, [Math]::Max(1, $width - 1), [Math]::Max(1, $height - 1), 0x0014)
        Start-Sleep -Milliseconds 200
        [void][SegmaWindowProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, $rect.Left, $rect.Top, $width, $height, 0x0014)
    }
}

if ($CapturePath) {
    & "$PSScriptRoot\.codex-inspect-window.ps1" -CapturePath $CapturePath
}
