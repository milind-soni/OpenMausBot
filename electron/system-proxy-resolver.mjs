import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class OmbProxySettings {
  [StructLayout(LayoutKind.Sequential)]
  public struct Settings { [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect; public IntPtr Url; public IntPtr Proxy; public IntPtr Bypass; }
  [DllImport("winhttp.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Settings settings);
  [DllImport("winhttp.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool WinHttpDetectAutoProxyConfigUrl(uint flags, out IntPtr url);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr value);
  public static string Read(IntPtr value) { return value == IntPtr.Zero ? null : Marshal.PtrToStringUni(value); }
}
'@
$settings = New-Object OmbProxySettings+Settings
if (![OmbProxySettings]::WinHttpGetIEProxyConfigForCurrentUser([ref]$settings)) { throw 'Cannot read current user proxy configuration' }
$discovered = [IntPtr]::Zero
try {
  $url = [OmbProxySettings]::Read($settings.Url)
  if ($settings.AutoDetect -and !$url) {
    if (![OmbProxySettings]::WinHttpDetectAutoProxyConfigUrl(3, [ref]$discovered)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($code -ne 12180) { throw 'Proxy auto-discovery failed' }
    }
  }
  @{ autoDetect=$settings.AutoDetect; pacUrl=$url; discoveredPacUrl=[OmbProxySettings]::Read($discovered); proxy=[OmbProxySettings]::Read($settings.Proxy); bypass=[OmbProxySettings]::Read($settings.Bypass) } | ConvertTo-Json -Compress
} finally {
  foreach ($ptr in @($settings.Url, $settings.Proxy, $settings.Bypass, $discovered)) { if ($ptr -ne [IntPtr]::Zero) { [void][OmbProxySettings]::GlobalFree($ptr) } }
}
`;

export async function readWindowsProxyConfig() {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 10000, maxBuffer: 65536,
    });
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (typeof result.autoDetect !== "boolean" || [result.pacUrl, result.discoveredPacUrl, result.proxy, result.bypass].some(value => value !== null && typeof value !== "string")) throw new Error();
    return result;
  } catch { throw new Error("Windows proxy configuration is unavailable"); }
}

export function createSystemProxyResolver({ session, platform = process.platform, readWindows = readWindowsProxyConfig }) {
  let applied;
  let discovered;
  return {
    async forceReloadProxyConfig() {
      let config = { mode: "system" };
      if (platform === "win32") {
        const settings = await readWindows();
        const pacUrl = settings.pacUrl || settings.discoveredPacUrl;
        if (!settings.autoDetect) discovered = undefined;
        if (!pacUrl && settings.autoDetect && discovered) throw new Error("Previously discovered PAC is unavailable");
        if (settings.discoveredPacUrl) discovered = settings.discoveredPacUrl;
        if (pacUrl) {
          const url = new URL(pacUrl);
          if (!["http:", "https:", "file:"].includes(url.protocol)) throw new Error("Unsupported PAC URL");
          // Electron 43's pac_script mode is mandatory; system mode may silently fall back to DIRECT.
          config = { mode: "pac_script", pacScript: url.href };
        } else if (settings.proxy) config = { mode: "fixed_servers", proxyRules: settings.proxy, proxyBypassRules: settings.bypass || "" };
        else config = { mode: "direct" };
      }
      const key = JSON.stringify(config);
      if (key !== applied) { await session.setProxy(config); applied = key; }
      await session.forceReloadProxyConfig();
    },
    resolveProxy: url => session.resolveProxy(url),
  };
}
