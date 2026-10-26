param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [int]$HoldMilliseconds = 0
)

$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (!$process) { exit 3 }

$deadline = [DateTime]::UtcNow.AddSeconds(5)
$window = [IntPtr]::Zero
do {
    $process.Refresh()
    $window = $process.MainWindowHandle
    if ($window -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

if ($window -eq [IntPtr]::Zero) { exit 4 }

$source = @"
using System;
using System.Runtime.InteropServices;
public static class SadxWindowFocus {
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
Add-Type -TypeDefinition $source
[SadxWindowFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[SadxWindowFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[uint32]$targetProcessId = 0
$targetThread = [SadxWindowFocus]::GetWindowThreadProcessId($window, [ref]$targetProcessId)
$currentThread = [SadxWindowFocus]::GetCurrentThreadId()
[SadxWindowFocus]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
[SadxWindowFocus]::ShowWindowAsync($window, 9) | Out-Null
[SadxWindowFocus]::SetForegroundWindow($window) | Out-Null
[SadxWindowFocus]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
Start-Sleep -Milliseconds 300

if ([SadxWindowFocus]::GetForegroundWindow() -ne $window) { exit 1 }

$holdUntil = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $HoldMilliseconds))
while ([DateTime]::UtcNow -lt $holdUntil) {
    try {
        $process.Refresh()
        if ($process.HasExited) { exit 3 }
    } catch {
        exit 3
    }
    if ([SadxWindowFocus]::GetForegroundWindow() -ne $window) {
        [SadxWindowFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [SadxWindowFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [SadxWindowFocus]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
        [SadxWindowFocus]::ShowWindowAsync($window, 9) | Out-Null
        [SadxWindowFocus]::SetForegroundWindow($window) | Out-Null
        [SadxWindowFocus]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
        Start-Sleep -Milliseconds 250
    } else {
        Start-Sleep -Milliseconds 100
    }
}
exit 0
