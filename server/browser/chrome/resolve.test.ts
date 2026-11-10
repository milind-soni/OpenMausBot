import { describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn((file: string) => ({ status: 0, stdout: file === "osascript" ? "/Applications/Google Chrome.app\n" : "" })));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawnSync }));

import { CHROME_FOR_TESTING_VERSION, chromeForTestingExecutable, chromeForTestingPin } from "./install.ts";
import { chromeHost, chromePolicyManaged, installedGoogleChrome, isHeadlessShell, registryData, resolveChromePlan, type ChromeHost } from "./resolve.ts";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function host(platform: NodeJS.Platform, files: string[], options: Partial<ChromeHost> & { registry?: Record<string, string>; keys?: string[] } = {}): ChromeHost {
  const present = new Set(files);
  return {
    platform,
    arch: platform === "win32" ? "x64" : "arm64",
    env: {},
    dataDir: "/data",
    home: platform === "win32" ? "C:\\Users\\ada" : "/home/ada",
    exists: (path) => present.has(path),
    list: (directory) => [...present].filter((path) => path.startsWith(`${directory}/`)).map((path) => path.slice(directory.length + 1).split("/")[0]!),
    registryValue: (key) => options.registry?.[key] ?? null,
    registryKeyExists: (key) => options.keys?.includes(key) ?? false,
    appForBundleId: () => null,
    ...options,
  };
}

const managed = { managed: true };

describe("which Chrome the bots' browser runs", () => {
  it("is the installed Google Chrome on a Mac, found through LaunchServices first", () => {
    expect(resolveChromePlan(host("darwin", [MAC_CHROME]), managed)).toEqual({ kind: "chrome", chrome: { path: MAC_CHROME, source: "installed" }, fallback: chromeForTestingPin("darwin", "arm64") });
    const elsewhere = "/Volumes/Apps/Google Chrome.app";
    const found = host("darwin", [MAC_CHROME, `${elsewhere}/Contents/MacOS/Google Chrome`], { appForBundleId: (id) => id === "com.google.Chrome" ? elsewhere : null });
    expect(installedGoogleChrome(found)).toBe(`${elsewhere}/Contents/MacOS/Google Chrome`);
    expect(installedGoogleChrome(host("darwin", ["/home/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]))).toBe("/home/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("skips a Google Chrome an organization manages, machine-wide or for this user, for Chrome for Testing", () => {
    for (const policy of ["/Library/Managed Preferences/com.google.Chrome.plist", "/Library/Managed Preferences/ada/com.google.Chrome.plist"]) {
      const mac = host("darwin", [MAC_CHROME, policy]);
      expect(chromePolicyManaged(mac)).toBe(true);
      expect(resolveChromePlan(mac, managed)).toEqual({ kind: "download", pin: chromeForTestingPin("darwin", "arm64") });
    }
    const pin = chromeForTestingPin("darwin", "arm64")!;
    const downloaded = chromeForTestingExecutable("/data", pin);
    expect(resolveChromePlan(host("darwin", [MAC_CHROME, "/Library/Managed Preferences/com.google.Chrome.plist", downloaded]), managed))
      .toEqual({ kind: "chrome", chrome: { path: downloaded, source: "downloaded" }, fallback: null });
  });

  it("reads Windows' App Paths and machine policies from the registry", () => {
    const exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const appPaths = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
    const windows = host("win32", [exe], { registry: { [appPaths]: `"${exe}"` } });
    expect(resolveChromePlan(windows, managed)).toMatchObject({ kind: "chrome", chrome: { path: exe, source: "installed" } });
    const policed = host("win32", [exe], { registry: { [appPaths]: exe }, keys: ["HKLM\\SOFTWARE\\Policies\\Google\\Chrome"] });
    expect(chromePolicyManaged(policed)).toBe(true);
    expect(resolveChromePlan(policed, managed)).toEqual({ kind: "legacy", reason: "Google Chrome here is managed by an organization" });
    const perUser = host("win32", ["C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"], { env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" } });
    expect(installedGoogleChrome(perUser)).toMatch(/AppData.Local.Google.Chrome.Application.chrome\.exe$/u);
  });

  it("parses reg.exe's default value and named values", () => {
    const output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\r\n";
    expect(registryData(output, undefined)).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(registryData(output, "Path")).toBe("C:\\Program Files\\Google\\Chrome\\Application");
    expect(registryData(output, "Missing")).toBeNull();
  });

  it("on a Linux desktop without its own Google Chrome keeps the bundled shell, as a fixed choice", () => {
    const linuxDesktop = (files: string[]) => host("linux", files, { env: { OMB_RESOURCES_PATH: "/opt/OpenMausBot/resources" } });
    expect(resolveChromePlan(linuxDesktop(["/opt/google/chrome/chrome"]), managed)).toMatchObject({ kind: "chrome", chrome: { source: "installed" }, fallback: null });
    expect(resolveChromePlan(linuxDesktop([]), managed)).toEqual({ kind: "legacy", reason: "Google Chrome is not installed" });
    const policy = linuxDesktop(["/opt/google/chrome/chrome", "/etc/opt/chrome/policies/managed/corp.json"]);
    expect(chromePolicyManaged(policy)).toBe(true);
    expect(resolveChromePlan(policy, managed)).toEqual({ kind: "legacy", reason: "Google Chrome here is managed by an organization" });
    expect(chromePolicyManaged(linuxDesktop(["/etc/opt/chrome/policies/managed/README"]))).toBe(false);
  });

  it("on a server uses the Chrome for Testing agent-browser installed, newest first", () => {
    const server = host("linux", ["/home/ada/.agent-browser/browsers/chrome-152.0.1.2/chrome", "/home/ada/.agent-browser/browsers/chrome-153.0.8010.47/chrome"]);
    expect(resolveChromePlan(server, managed)).toEqual({ kind: "chrome", chrome: { path: "/home/ada/.agent-browser/browsers/chrome-153.0.8010.47/chrome", source: "agent-browser" }, fallback: null });
  });

  it("on a Linux server without any Chrome downloads Chrome for Testing, as on a Mac", () => {
    expect(resolveChromePlan(host("linux", []), managed)).toEqual({ kind: "download", pin: chromeForTestingPin("linux", "arm64") });
    expect(resolveChromePlan({ ...host("linux", []), arch: "x64" }, managed)).toEqual({ kind: "download", pin: chromeForTestingPin("linux", "x64") });
    const downloaded = chromeForTestingExecutable("/data", chromeForTestingPin("linux", "arm64")!);
    expect(downloaded.replaceAll("\\", "/")).toBe("/data/tools/chrome/153.0.8010.47/linux-arm64/chrome-linux-arm64/chrome");
    expect(resolveChromePlan(host("linux", [downloaded]), managed)).toEqual({ kind: "chrome", chrome: { path: downloaded, source: "downloaded" }, fallback: null });
    expect(resolveChromePlan(host("linux", ["/opt/google/chrome/chrome"]), managed)).toEqual({ kind: "chrome", chrome: { path: "/opt/google/chrome/chrome", source: "installed" }, fallback: chromeForTestingPin("linux", "arm64") });
    expect(resolveChromePlan({ ...host("linux", []), arch: "ia32" }, managed)).toEqual({ kind: "legacy", reason: "no Chrome is installed and none is pinned for this platform" });
  });

  it("on a Linux server keeps a browser agent-browser already finds, rather than downloading another", () => {
    const found = { kind: "legacy", reason: "agent-browser found a browser on this server" };
    const withPath = (files: string[], env: NodeJS.ProcessEnv = {}) => host("linux", files, { env: { PATH: "/usr/local/bin:/usr/bin", ...env } });
    expect(resolveChromePlan(withPath(["/usr/bin/chromium"]), managed)).toEqual(found);
    expect(resolveChromePlan(withPath(["/usr/local/bin/google-chrome-stable"]), managed)).toEqual(found);
    expect(resolveChromePlan(withPath(["/home/ada/.cache/puppeteer/chrome/linux-153.0.8010.47/chrome-linux64/chrome"]), managed)).toEqual(found);
    expect(resolveChromePlan(withPath(["/home/ada/.cache/ms-playwright/chromium-1200/chrome-linux/chrome"]), managed)).toEqual(found);
    expect(resolveChromePlan(withPath(["/pw/chromium-1200/chrome-linux64/chrome"], { PLAYWRIGHT_BROWSERS_PATH: "/pw" }), managed)).toEqual(found);
    // A cache entry without its browser executable is incomplete: the server still downloads.
    expect(resolveChromePlan(withPath(["/home/ada/.cache/puppeteer/chrome/linux-153.0.8010.47/README"]), managed)).toMatchObject({ kind: "download" });
    expect(resolveChromePlan(withPath(["/home/ada/.cache/ms-playwright/chromium-1200/INSTALLATION_COMPLETE"]), managed)).toMatchObject({ kind: "download" });
    expect(resolveChromePlan(withPath(["/home/ada/.cache/ms-playwright/firefox-1500", "/opt/firefox/firefox"]), managed)).toMatchObject({ kind: "download" });
    const downloaded = chromeForTestingExecutable("/data", chromeForTestingPin("linux", "arm64")!);
    expect(resolveChromePlan(withPath(["/usr/bin/chromium", downloaded]), managed)).toMatchObject({ kind: "chrome", chrome: { source: "downloaded" } });
  });

  it("wraps a Chrome named by the environment, as the Docker image names its Chrome for Testing", () => {
    const named = (env: NodeJS.ProcessEnv, files: string[]) => host("linux", files, { env });
    expect(resolveChromePlan(named({ AGENT_BROWSER_EXECUTABLE_PATH: "/opt/openmausbot-browser/chrome" }, ["/opt/openmausbot-browser/chrome"]), null))
      .toEqual({ kind: "chrome", chrome: { path: "/opt/openmausbot-browser/chrome", source: "named" }, fallback: null });
    expect(resolveChromePlan(named({ OMB_CHROME_PATH: "/x/chrome", AGENT_BROWSER_EXECUTABLE_PATH: "/y/chrome" }, ["/x/chrome", "/y/chrome"]), null))
      .toMatchObject({ chrome: { path: "/x/chrome" } });
    expect(resolveChromePlan(named({ AGENT_BROWSER_EXECUTABLE_PATH: "/b/chrome-headless-shell-linux64/chrome-headless-shell" }, ["/b/chrome-headless-shell-linux64/chrome-headless-shell"]), managed))
      .toEqual({ kind: "legacy", reason: "the named browser is a headless shell" });
    expect(resolveChromePlan(named({ AGENT_BROWSER_EXECUTABLE_PATH: "/gone/chrome" }, []), managed)).toEqual({ kind: "legacy", reason: "/gone/chrome does not exist" });
  });

  it("leaves the engine's own choice alone when agent-browser itself was named, and on OMB_BROWSER_LEGACY_SHELL=1", () => {
    expect(resolveChromePlan(host("darwin", [MAC_CHROME]), { managed: false })).toMatchObject({ kind: "legacy" });
    expect(resolveChromePlan(host("darwin", [MAC_CHROME]), null)).toMatchObject({ kind: "legacy" });
    expect(resolveChromePlan(host("darwin", [MAC_CHROME, "/x/chrome"], { env: { OMB_BROWSER_LEGACY_SHELL: "1", OMB_CHROME_PATH: "/x/chrome" } }), managed))
      .toEqual({ kind: "legacy", reason: "OMB_BROWSER_LEGACY_SHELL=1" });
  });

  it("downloads only for a platform with a SHA-256 pin, and keeps the bundled shell where none is pinned yet", () => {
    expect(chromeForTestingPin("darwin", "arm64")).toMatchObject({ version: CHROME_FOR_TESTING_VERSION, platform: "mac-arm64", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(resolveChromePlan(host("darwin", []), managed)).toEqual({ kind: "download", pin: chromeForTestingPin("darwin", "arm64") });
    expect(resolveChromePlan({ ...host("darwin", []), arch: "x64" }, managed)).toEqual({ kind: "legacy", reason: "no Chrome is installed and none is pinned for this platform" });
    expect(resolveChromePlan(host("win32", []), managed)).toEqual({ kind: "legacy", reason: "no Chrome is installed and none is pinned for this platform" });
  });

  it("knows the headless shell by name", () => {
    expect(isHeadlessShell("/r/browser-engine/chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell")).toBe(true);
    expect(isHeadlessShell("C:\\r\\chrome-headless-shell-win64\\chrome-headless-shell.exe")).toBe(true);
    expect(isHeadlessShell(MAC_CHROME)).toBe(false);
    expect(isHeadlessShell("/opt/openmausbot-browser/chrome")).toBe(false);
  });

  it("asks LaunchServices and the registry once per host, since each answer costs a process", () => {
    spawnSync.mockClear();
    const mac = chromeHost({ dataDir: "/data", env: {}, platform: "darwin" });
    for (let i = 0; i < 3; i++) expect(mac.appForBundleId("com.google.Chrome")).toBe("/Applications/Google Chrome.app");
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync.mock.calls[0]![0]).toBe("osascript");
    spawnSync.mockClear();
    const windows = chromeHost({ dataDir: "C:\\data", env: {}, platform: "win32" });
    for (let i = 0; i < 3; i++) {
      windows.registryValue("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe");
      windows.registryKeyExists("HKLM\\SOFTWARE\\Policies\\Google\\Chrome");
    }
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls.map((call) => call[0])).toEqual(["reg", "reg"]);
  });
});
