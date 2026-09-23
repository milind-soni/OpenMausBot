// Packaging smoke only: find visible console windows for our exact helper
// paths. No windows are focused, hidden, closed, or otherwise manipulated.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function assertNoHelperWindows(paths) {
  if (process.platform !== "win32") return;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OmbHelperWindows {
  delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  public static string[] Titles() {
    var titles = new List<string>();
    EnumWindows((window, data) => {
      if (IsWindowVisible(window)) {
        var text = new StringBuilder(32768);
        GetWindowText(window, text, text.Capacity);
        titles.Add(text.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return titles.ToArray();
  }
}
'@
$paths = ConvertFrom-Json $env:OMB_HELPER_WINDOW_PATHS
$matches = @([OmbHelperWindows]::Titles() | Where-Object {
  $title = $_
  @($paths | Where-Object { $title.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
})
ConvertTo-Json -InputObject $matches -Compress
`], { env: { ...process.env, OMB_HELPER_WINDOW_PATHS: JSON.stringify(paths) }, windowsHide: true, timeout: 15_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), [], "A background helper opened a visible Windows console");
}
