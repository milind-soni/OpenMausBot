// The display a headless bot browser reports: the computer's primary display with its real scale factor on a desktop
// (2 on a Retina Mac, so pages and frames are sharp), a declared 1920x1080 at 1x on a server, as Xvfb's -screen does.
import { execFile } from "node:child_process";

import { SERVER_SCREEN, type HostKind, type ScreenSpec } from "./chrome/flags.ts";

type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const run: Run = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

/** NSScreen's frame is in points, the unit of a page's `screen.width`; backingScaleFactor is the device pixel ratio. */
const MAC_DISPLAY = `ObjC.import("AppKit"); const screen = $.NSScreen.screens.objectAtIndex(0); const size = screen.frame.size; Math.round(size.width) + "x" + Math.round(size.height) + "@" + screen.backingScaleFactor`;
/** WPF reports the primary screen in device-independent pixels; AppliedDPI is the scale the person set, 96 being 1x. */
const WINDOWS_DISPLAY = "Add-Type -AssemblyName PresentationFramework; $dpi = (Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI; if (-not $dpi) { $dpi = 96 }; '{0}x{1}@{2}' -f [System.Windows.SystemParameters]::PrimaryScreenWidth, [System.Windows.SystemParameters]::PrimaryScreenHeight, ($dpi / 96)";

/** "1512x982@2", "1920x1080" (1x) or nothing. */
export function parseDisplay(text: string): ScreenSpec | null {
  const match = /(\d{3,5})x(\d{3,5})(?:@(\d+(?:\.\d+)?))?/u.exec(text);
  if (!match) return null;
  const scale = match[3] === undefined ? 1 : Number(match[3]);
  if (!(scale >= 1 && scale <= 4)) return null;
  return { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor: Math.round(scale * 100) / 100 };
}

/** Cinnamon, GNOME and KDE set a HiDPI or fractional scale as Xft.dpi (96 being 1x), not GDK_SCALE; the app's own window
 *  draws at that scale, so a page at 1x would look blurry in it. */
async function xftScale(runCommand: Run): Promise<number> {
  try {
    const dpi = Number(/^Xft\.dpi:\s*(\d+(?:\.\d+)?)\s*$/mu.exec(await runCommand("xrdb", ["-query"], 5_000))?.[1]);
    const scale = Math.round((dpi / 96) * 100) / 100;
    return scale > 1 && scale <= 4 ? scale : 1;
  } catch {
    return 1;
  }
}

export async function displayScreen(host: HostKind, { platform = process.platform, env = process.env, runCommand = run }: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; runCommand?: Run } = {}): Promise<ScreenSpec> {
  const named = parseDisplay(env.OMB_BROWSER_SCREEN?.trim() ?? "");
  if (named) return named;
  if (host !== "desktop") return SERVER_SCREEN;
  try {
    if (platform === "darwin") return parseDisplay(await runCommand("osascript", ["-l", "JavaScript", "-e", MAC_DISPLAY], 5_000)) ?? SERVER_SCREEN;
    if (platform === "win32") return parseDisplay(await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DISPLAY], 15_000)) ?? SERVER_SCREEN;
    if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
      const lines = (await runCommand("xrandr", ["--current"], 5_000)).split("\n").filter((line) => / connected /u.test(line));
      const pixels = parseDisplay(lines.find((line) => / primary /u.test(line)) ?? lines[0] ?? "");
      if (!pixels) return SERVER_SCREEN;
      const gdkScale = Number(env.GDK_SCALE);
      // An explicit GDK_SCALE wins, 1 included. Under Wayland, XWayland's RandR size can already be logical, so Xft.dpi is only read in an X11 session.
      const x11 = !env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "wayland";
      const scale = Number.isInteger(gdkScale) && gdkScale >= 1 && gdkScale <= 4 ? gdkScale : x11 ? await xftScale(runCommand) : 1;
      return { width: Math.round(pixels.width / scale), height: Math.round(pixels.height / scale), deviceScaleFactor: scale };
    }
  } catch {}
  return SERVER_SCREEN;
}
