param(
    [Parameter(Mandatory = $true)][string]$ProcessName,
    [int]$IntervalMs = 1500,
    [int]$ParentPid = 0
)

# Keeps the game's window streamable while the room runs, one line on stdout per event:
#   restored minimized|maximized  the window was put back to its normal size without activating it
#                                 (SW_SHOWNOACTIVATE): a minimized window doesn't draw, and a maximized
#                                 one renders so many more pixels that SADX drops to a few fps
#   size WxH                      the window's client area changed; the capture keeps the size it
#                                 started with, so the room restarts its encoder
#   gone                          no window (the game closed)
# Runs until the room kills it, or until the room's process (-ParentPid) is gone.
$ErrorActionPreference = 'Stop'
$name = [System.IO.Path]::GetFileNameWithoutExtension($ProcessName)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SadxGameWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
}
"@
$lastSize = ''
while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
    $window = [IntPtr]::Zero
    foreach ($process in Get-Process -Name $name -ErrorAction SilentlyContinue) {
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $window = $process.MainWindowHandle; break }
    }
    if ($window -eq [IntPtr]::Zero) {
        if ($lastSize -ne 'gone') { [Console]::Out.WriteLine('gone'); $lastSize = 'gone' }
    } else {
        $state = if ([SadxGameWindow]::IsIconic($window)) { 'minimized' } elseif ([SadxGameWindow]::IsZoomed($window)) { 'maximized' } else { $null }
        if ($state) {
            [SadxGameWindow]::ShowWindow($window, 4) | Out-Null
            [Console]::Out.WriteLine("restored $state")
            Start-Sleep -Milliseconds 300
        }
        $rect = New-Object SadxGameWindow+RECT
        if ([SadxGameWindow]::GetClientRect($window, [ref]$rect)) {
            $size = "$($rect.Right)x$($rect.Bottom)"
            if ($size -ne $lastSize -and $rect.Right -gt 0) { [Console]::Out.WriteLine("size $size"); $lastSize = $size }
        }
    }
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}
