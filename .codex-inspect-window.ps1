param(
    [switch]$RefreshVideo,
    [string]$CapturePath = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class SegmaWindowInspector {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr lparam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowRgnBox(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);

    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hwnd, IntPtr updateRect, IntPtr updateRegion, uint flags);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr deviceContext, uint flags);
}
'@

$process = Get-Process -Name 'aura-media-manager' -ErrorAction SilentlyContinue |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
if (-not $process) {
    Write-Output 'MANAGER_NOT_RUNNING'
    exit 0
}

$root = $process.MainWindowHandle
$handles = [System.Collections.Generic.List[System.IntPtr]]::new()
$handles.Add($root)
[SegmaWindowInspector]::EnumChildWindows(
    $root,
    {
        param([IntPtr]$hwnd, [IntPtr]$unused)
        $handles.Add($hwnd)
        return $true
    },
    [IntPtr]::Zero
) | Out-Null

$rows = foreach ($hwnd in $handles) {
    $class = [Text.StringBuilder]::new(256)
    $title = [Text.StringBuilder]::new(256)
    [void][SegmaWindowInspector]::GetClassName($hwnd, $class, $class.Capacity)
    [void][SegmaWindowInspector]::GetWindowText($hwnd, $title, $title.Capacity)
    $window = [SegmaWindowInspector+RECT]::new()
    $client = [SegmaWindowInspector+RECT]::new()
    $region = [SegmaWindowInspector+RECT]::new()
    [void][SegmaWindowInspector]::GetWindowRect($hwnd, [ref]$window)
    [void][SegmaWindowInspector]::GetClientRect($hwnd, [ref]$client)
    $regionKind = [SegmaWindowInspector]::GetWindowRgnBox($hwnd, [ref]$region)
    $ownerPid = 0
    [void][SegmaWindowInspector]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
    [pscustomobject]@{
        Hwnd = '0x{0:X}' -f $hwnd.ToInt64()
        Parent = '0x{0:X}' -f ([SegmaWindowInspector]::GetParent($hwnd)).ToInt64()
        Pid = $ownerPid
        Dpi = [SegmaWindowInspector]::GetDpiForWindow($hwnd)
        DpiAwareness = [SegmaWindowInspector]::GetAwarenessFromDpiAwarenessContext(
            [SegmaWindowInspector]::GetWindowDpiAwarenessContext($hwnd)
        )
        Visible = [SegmaWindowInspector]::IsWindowVisible($hwnd)
        Class = $class.ToString()
        Title = $title.ToString()
        Window = '{0},{1} {2}x{3}' -f $window.Left, $window.Top, ($window.Right - $window.Left), ($window.Bottom - $window.Top)
        Client = '{0}x{1}' -f ($client.Right - $client.Left), ($client.Bottom - $client.Top)
        Region = '{0}: {1},{2} {3}x{4}' -f $regionKind, $region.Left, $region.Top, ($region.Right - $region.Left), ($region.Bottom - $region.Top)
    }
}

$rows | Format-Table -AutoSize

if ($RefreshVideo) {
    $video = $handles | Where-Object {
        $class = [Text.StringBuilder]::new(64)
        [void][SegmaWindowInspector]::GetClassName($_, $class, $class.Capacity)
        $class.ToString() -eq 'Static'
    } | Select-Object -First 1
    if ($video) {
        $client = [SegmaWindowInspector+RECT]::new()
        [void][SegmaWindowInspector]::GetClientRect($video, [ref]$client)
        $width = $client.Right - $client.Left
        $height = $client.Bottom - $client.Top
        $sizeLparam = [IntPtr](($height -shl 16) -bor ($width -band 0xffff))
        [void][SegmaWindowInspector]::SendMessage($video, 0x0005, [IntPtr]::Zero, $sizeLparam)
        [void][SegmaWindowInspector]::RedrawWindow($video, [IntPtr]::Zero, [IntPtr]::Zero, 0x0085)
        Write-Output "REFRESHED_VIDEO ${width}x${height}"
    }
}

if ($CapturePath) {
    Add-Type -AssemblyName System.Drawing
    $window = [SegmaWindowInspector+RECT]::new()
    [void][SegmaWindowInspector]::GetWindowRect($root, [ref]$window)
    $width = $window.Right - $window.Left
    $height = $window.Bottom - $window.Top
    $bitmap = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $dc = $graphics.GetHdc()
        try {
            [void][SegmaWindowInspector]::PrintWindow($root, $dc, 0x00000002)
        } finally {
            $graphics.ReleaseHdc($dc)
        }
        $bitmap.Save($CapturePath, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
    Write-Output "CAPTURED $CapturePath"
}
