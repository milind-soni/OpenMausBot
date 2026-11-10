// Which Chrome the bots' browser runs. The person's installed Google Chrome comes first, unless an organization manages it:
// its policies can switch off remote debugging or force extensions in. Then Chrome for Testing, pinned and downloaded once.
// A machine with neither keeps the engine's own browser, and that stays its choice; nothing switches browsers mid-session.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";

import { chromeForTestingExecutable, chromeForTestingPin, type ChromeForTestingPin } from "./install.ts";

export type ChromeSource = "installed" | "downloaded" | "named" | "agent-browser";

export interface FoundChrome { path: string; source: ChromeSource }

export type ChromePlan =
  /** `fallback` is the download to use when the installed Chrome cannot be started headless. */
  | { kind: "chrome"; chrome: FoundChrome; fallback: ChromeForTestingPin | null }
  | { kind: "download"; pin: ChromeForTestingPin }
  | { kind: "legacy"; reason: string };

export interface ChromeHost {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  home: string;
  exists(path: string): boolean;
  list(directory: string): string[];
  /** A registry value's data, null when the key or value is missing; `name` omitted reads the key's default value. */
  registryValue(key: string, name?: string): string | null;
  registryKeyExists(key: string): boolean;
  /** LaunchServices' answer for a bundle id on macOS. */
  appForBundleId(bundleId: string): string | null;
  /** The PATH agent-browser is started with, when it differs from `env.PATH`. */
  enginePath?: () => string;
}

export interface ChromeEngine {
  /** The agent-browser OMB installed and manages; an engine someone named picks its own browser unless a Chrome is named too. */
  managed: boolean;
}

const MAC_CHROME_BINARY = "Contents/MacOS/Google Chrome";
const MAC_POLICIES = "/Library/Managed Preferences";
const WINDOWS_POLICIES = "HKLM\\SOFTWARE\\Policies\\Google\\Chrome";
const WINDOWS_APP_PATHS = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
const LINUX_CHROME = "/opt/google/chrome/chrome";
const LINUX_POLICIES = "/etc/opt/chrome/policies/managed";
const AGENT_BROWSER_LAYOUTS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  linux: "chrome",
  win32: "chrome.exe",
};

const paths = (platform: NodeJS.Platform) => platform === "win32" ? win32 : posix;

/** Chromium's headless shell cannot pass for Chrome: its TLS handshake differs and it has no `window.chrome`. */
export function isHeadlessShell(path: string): boolean {
  return /chrome-headless-shell/iu.test(path);
}

export function installedGoogleChrome(host: ChromeHost): string | null {
  const { join } = paths(host.platform);
  const candidates: string[] = [];
  if (host.platform === "darwin") {
    const registered = host.appForBundleId("com.google.Chrome");
    if (registered) candidates.push(join(registered, MAC_CHROME_BINARY));
    candidates.push(join("/Applications/Google Chrome.app", MAC_CHROME_BINARY), join(host.home, "Applications/Google Chrome.app", MAC_CHROME_BINARY));
  } else if (host.platform === "win32") {
    for (const hive of ["HKLM", "HKCU"]) {
      const registered = host.registryValue(`${hive}\\${WINDOWS_APP_PATHS}`);
      if (registered) candidates.push(registered.replace(/^"|"$/gu, ""));
    }
    for (const root of [host.env.ProgramFiles, host.env["ProgramFiles(x86)"], host.env.LOCALAPPDATA]) {
      if (root) candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (host.platform === "linux") {
    candidates.push(LINUX_CHROME);
  }
  return candidates.find((candidate) => host.exists(candidate)) ?? null;
}

/** Machine policies only: a managed machine runs Chrome for Testing in profiles of OMB's own instead. */
export function chromePolicyManaged(host: ChromeHost): boolean {
  const { basename, join } = paths(host.platform);
  if (host.platform === "darwin") {
    const user = host.env.USER || basename(host.home);
    return host.exists(join(MAC_POLICIES, "com.google.Chrome.plist")) || host.exists(join(MAC_POLICIES, user, "com.google.Chrome.plist"));
  }
  if (host.platform === "win32") return host.registryKeyExists(WINDOWS_POLICIES);
  if (host.platform === "linux") return host.list(LINUX_POLICIES).some((name) => name.endsWith(".json"));
  return false;
}

/** The Chrome for Testing `agent-browser install` unpacked for this user, newest first. */
export function agentBrowserChrome(host: ChromeHost): string | null {
  const layout = AGENT_BROWSER_LAYOUTS[host.platform];
  if (!layout) return null;
  const { join } = paths(host.platform);
  const browsers = join(host.home, ".agent-browser", "browsers");
  const versions = host.list(browsers).filter((name) => name.startsWith("chrome-")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions.map((version) => join(browsers, version, layout)).find((candidate) => host.exists(candidate)) ?? null;
}

/** agent-browser's own search on Linux: these browsers on PATH, then Puppeteer's and Playwright's caches. */
const LINUX_ENGINE_BROWSERS = ["google-chrome", "google-chrome-stable", "google-chrome-unstable", "chromium", "chromium-browser", "brave-browser", "brave-browser-stable"];

/** Where Puppeteer and Playwright unpack Chrome inside a cache entry; an entry without one is incomplete. */
const LINUX_CACHE_EXECUTABLES = ["chrome-linux64/chrome", "chrome-linux/chrome"];

/** A Linux server where agent-browser already finds a browser keeps it rather than downloading another. */
export function engineFindsLinuxBrowser(host: ChromeHost): boolean {
  const { join } = posix;
  const onPath = (host.enginePath?.() ?? host.env.PATH ?? "").split(":").filter(Boolean);
  if (onPath.some((directory) => LINUX_ENGINE_BROWSERS.some((name) => host.exists(join(directory, name))))) return true;
  const cached = (directory: string, prefix: string) => host.list(directory)
    .some((name) => name.startsWith(prefix) && LINUX_CACHE_EXECUTABLES.some((executable) => host.exists(join(directory, name, executable))));
  return cached(join(host.env.PUPPETEER_CACHE_DIR || join(host.home, ".cache", "puppeteer"), "chrome"), "linux")
    || cached(host.env.PLAYWRIGHT_BROWSERS_PATH || join(host.home, ".cache", "ms-playwright"), "chromium-");
}

export function resolveChromePlan(host: ChromeHost, engine: ChromeEngine | null): ChromePlan {
  const { env, platform } = host;
  if (env.OMB_BROWSER_LEGACY_SHELL?.trim() === "1") return { kind: "legacy", reason: "OMB_BROWSER_LEGACY_SHELL=1" };
  const named = env.OMB_CHROME_PATH?.trim() || env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (named) {
    if (isHeadlessShell(named)) return { kind: "legacy", reason: "the named browser is a headless shell" };
    if (!host.exists(named)) return { kind: "legacy", reason: `${named} does not exist` };
    return { kind: "chrome", chrome: { path: paths(platform).isAbsolute(named) ? named : resolve(named), source: "named" }, fallback: null };
  }
  if (!engine?.managed) return { kind: "legacy", reason: "agent-browser was named, so it picks its own browser" };
  // The Linux desktop app keeps its bundled browser; a Linux server downloads Chrome for Testing like a Mac.
  const pin = platform === "linux" && env.OMB_RESOURCES_PATH ? null : chromeForTestingPin(platform, host.arch);
  const installed = installedGoogleChrome(host);
  if (installed && !chromePolicyManaged(host)) return { kind: "chrome", chrome: { path: installed, source: "installed" }, fallback: pin };
  if (platform === "linux" && env.OMB_RESOURCES_PATH) return { kind: "legacy", reason: installed ? "Google Chrome here is managed by an organization" : "Google Chrome is not installed" };
  const own = agentBrowserChrome(host);
  if (own) return { kind: "chrome", chrome: { path: own, source: "agent-browser" }, fallback: null };
  if (pin) {
    const executable = chromeForTestingExecutable(host.dataDir, pin);
    if (host.exists(executable)) return { kind: "chrome", chrome: { path: executable, source: "downloaded" }, fallback: null };
    if (platform === "linux" && engineFindsLinuxBrowser(host)) return { kind: "legacy", reason: "agent-browser found a browser on this server" };
    return { kind: "download", pin };
  }
  return { kind: "legacy", reason: installed ? "Google Chrome here is managed by an organization" : "no Chrome is installed and none is pinned for this platform" };
}

function registryQuery(args: string[]): string | null {
  const result = spawnSync("reg", ["query", ...args], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

/** `reg query` prints `    (Default)    REG_SZ    C:\…\chrome.exe`. */
export function registryData(output: string, name: string | undefined): string | null {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/u.exec(line);
    if (match && (name === undefined ? /^\(.*\)$/u.test(match[1]!) : match[1] === name)) return match[2]!.trim() || null;
  }
  return null;
}

/** NSWorkspace's application lookup, which is what `open -b` uses; a missing app answers nothing. */
function launchServicesApp(bundleId: string): string | null {
  const script = `ObjC.import("AppKit"); const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(${JSON.stringify(bundleId)}); url.isNil() ? "" : url.path.js`;
  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", timeout: 3_000 });
  return result.status === 0 && result.stdout.trim().endsWith(".app") ? result.stdout.trim() : null;
}

/** The registry and LaunchServices take a process each, so each answer is read once per host; files are checked every time. */
export function chromeHost(options: { dataDir: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; enginePath?: () => string }): ChromeHost {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const answers = new Map<string, string | null>();
  const once = (key: string, read: () => string | null) => {
    if (!answers.has(key)) answers.set(key, read());
    return answers.get(key)!;
  };
  return {
    platform,
    arch: options.arch ?? process.arch,
    env,
    dataDir: options.dataDir,
    ...(options.enginePath ? { enginePath: options.enginePath } : {}),
    home: (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir(),
    exists: existsSync,
    list: (directory) => { try { return readdirSync(directory); } catch { return []; } },
    registryValue: (key, name) => platform !== "win32" ? null : once(`value\0${key}\0${name ?? ""}`, () => {
      const output = registryQuery([key, ...(name ? ["/v", name] : ["/ve"])]);
      return output === null ? null : registryData(output, name);
    }),
    registryKeyExists: (key) => platform === "win32" && once(`key\0${key}`, () => registryQuery([key]) === null ? null : "") !== null,
    appForBundleId: (bundleId) => platform === "darwin" ? once(`app\0${bundleId}`, () => launchServicesApp(bundleId)) : null,
  };
}
