// Chrome's command line for a bot browser. Pages see only what this binary
// shows when headed: no --enable-automation, AutomationControlled off, the
// headed user agent, the real display, the person's language.

import { userInfo } from "node:os";

import { credentialStoreFlags, gateChromeFlags } from "../egress/gate.ts";

export type BrowserMode = "headless" | "window";
export type HostKind = "desktop" | "server" | "container";

export interface ScreenSpec {
  /** CSS pixels, as the display reports them. */
  width: number;
  height: number;
  deviceScaleFactor: number;
  colorDepth?: number;
  /** CSS pixels the system keeps for itself at each edge (menu bar, taskbar). */
  workArea?: { left?: number; top?: number; right?: number; bottom?: number };
}

/** Servers declare a display the way Xvfb's -screen does. */
export const SERVER_SCREEN: ScreenSpec = { width: 1920, height: 1080, deviceScaleFactor: 1 };

/** New headless reserves this much of a window's height on macOS and Linux; the driver fits other platforms' windows. */
const HEADLESS_CHROME_HEIGHT = 143;

/** A 1280x720 page on macOS and Linux. */
export const WINDOW_SIZE = "1280,863";

/**
 * The most a headless window adds to its page, measured on 153 and 155: --window-size=1280,863 shows a 1280x720 page on
 * macOS and Linux and a 1264x712 one on Windows in Google Chrome's first tab, which carries a 56 px bar the others lack.
 */
function windowFrame(platform: NodeJS.Platform): { width: number; height: number } {
  return platform === "win32" ? { width: 16, height: 151 } : { width: 0, height: HEADLESS_CHROME_HEIGHT };
}

/** The largest page a headless window can show on `screen`: no real window is larger than its screen. */
export function pageLimit(screen: ScreenSpec, platform: NodeJS.Platform = process.platform): { width: number; height: number } {
  const frame = windowFrame(platform);
  return { width: screen.width - frame.width, height: screen.height - frame.height };
}

/** `page`, scaled down to fit `limit` with its shape kept, so a viewer that scales it back up is still filled edge to edge. */
export function fitPage(page: { width: number; height: number }, limit: { width: number; height: number } | null): { width: number; height: number } {
  if (!limit || (page.width <= limit.width && page.height <= limit.height)) return page;
  const scale = Math.min(limit.width / page.width, limit.height / page.height);
  return { width: Math.min(limit.width, Math.floor(page.width * scale + 1e-6)), height: Math.min(limit.height, Math.floor(page.height * scale + 1e-6)) };
}

export interface ChromeFlagsInput {
  userDataDir: string;
  mode: BrowserMode;
  host: HostKind;
  platform?: NodeJS.Platform;
  /** The calibrated headed user agent; headless only. */
  userAgent?: string | null;
  /** The display pages see; headless only (a window has the real one). */
  screen?: ScreenSpec | null;
  locale?: string | null;
  /** The port of this browser's egress gate on 127.0.0.1. */
  egressPort?: number | null;
  /** The page size the window opens at; the driver fits it exactly once a tab runs. */
  viewport?: { width: number; height: number } | null;
  /** False only when an operator explicitly turned Chrome's sandbox off. */
  sandbox?: boolean;
  /** Null when session restore reopens the profile's tabs. */
  startUrl?: string | null;
  /** A window only: where it opens, e.g. parked off-screen. */
  windowPosition?: { x: number; y: number } | null;
}

const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Headless takes the display in device pixels: --screen-info={3024x1964 devicePixelRatio=2 colorDepth=30} is a 1512x982 Retina screen. */
export function screenInfo(screen: ScreenSpec): string {
  const device = (css: number) => Math.round(css * screen.deviceScaleFactor);
  const parts = [`${device(screen.width)}x${device(screen.height)}`, `devicePixelRatio=${screen.deviceScaleFactor}`];
  if (screen.colorDepth) parts.push(`colorDepth=${screen.colorDepth}`);
  const area = screen.workArea ?? {};
  for (const [edge, inset] of [["Left", area.left], ["Top", area.top], ["Right", area.right], ["Bottom", area.bottom]] as const) {
    if (inset) parts.push(`workArea${edge}=${device(inset)}`);
  }
  return `{${parts.join(" ")}}`;
}

export function chromeArgs(input: ChromeFlagsInput): string[] {
  const platform = input.platform ?? process.platform;
  const headless = input.mode === "headless";
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${input.userDataDir}`,
    ...(headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    `--window-size=${input.viewport ? `${Math.round(input.viewport.width)},${Math.round(input.viewport.height) + HEADLESS_CHROME_HEIGHT}` : WINDOW_SIZE}`,
  ];
  if (headless && input.userAgent) {
    if (/[\r\n\0]/.test(input.userAgent)) throw new Error("The user agent holds a line break.");
    args.push(`--user-agent=${input.userAgent}`);
  }
  if (headless) args.push(`--screen-info=${screenInfo(input.screen ?? SERVER_SCREEN)}`);
  else if (input.windowPosition) args.push(`--window-position=${Math.round(input.windowPosition.x)},${Math.round(input.windowPosition.y)}`);
  if (input.locale && LOCALE.test(input.locale)) args.push(`--lang=${input.locale}`);
  if (input.egressPort !== undefined && input.egressPort !== null) {
    if (!Number.isInteger(input.egressPort) || input.egressPort < 1 || input.egressPort > 65_535) throw new Error("The browser only goes through OpenMausBot's own local gate.");
    args.push(...gateChromeFlags(input.egressPort, platform));
  } else {
    args.push(...credentialStoreFlags(platform));
  }
  // Chrome for Testing 155 keeps a --top-chrome-webui renderer for the omnibox popups and the WebUI reload button, which
  // headless never shows: about 50 MB per browser.
  if (headless) args.push("--mute-audio", "--disable-features=WebUIOmniboxPopup,WebUIOmniboxAimPopup,WebUIReloadButton");
  if (input.host !== "desktop") args.push("--disk-cache-size=52428800");
  if (input.host === "container") args.push("--disable-dev-shm-usage");
  if (input.sandbox === false) args.push("--no-sandbox");
  if (input.startUrl !== null) args.push(input.startUrl ?? "about:blank");
  return args;
}

export interface ChromeEnvInput {
  host: HostKind;
  /** The person's time zone; servers only, a desktop already has it. */
  timezone?: string | null;
  /** The setuid sandbox helper in containers. */
  sandboxHelper?: string | null;
  /** Marks the process for the boot sweep. */
  profileMarker?: string | null;
}

/** The account's own home, from the user database rather than HOME, which a test or a wrapper may have pointed elsewhere. */
export function accountHome(): string | null {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

/** Chrome keeps per-user state under the home directory, so it always gets the account's real one, never a temporary HOME. */
export function chromeEnv(base: NodeJS.ProcessEnv, input: ChromeEnvInput, home: string | null = accountHome()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (home) {
    env.HOME = home;
    if (process.platform === "win32") env.USERPROFILE = home;
  }
  if (input.host !== "desktop" && input.timezone) env.TZ = input.timezone;
  if (input.sandboxHelper) env.CHROME_DEVEL_SANDBOX = input.sandboxHelper;
  if (input.profileMarker) env.OMB_BROWSER_PROFILE = input.profileMarker;
  return env;
}
