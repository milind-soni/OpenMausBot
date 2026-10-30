import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import type { ChromeIdentity } from "./identity.ts";
import { chromeForTestingExecutable, chromeForTestingPin, type installChromeForTesting } from "./install.ts";
import { ChromeLauncher, runsLauncher } from "./launcher.ts";
import { chromeHost } from "./resolve.ts";
import type { IdentitySidecars } from "./sidecar.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

const identity = (major: string, brand = "Google Chrome"): ChromeIdentity => ({
  userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  userAgentMetadata: {
    brands: [{ brand, version: major }, { brand: "Chromium", version: major }], fullVersionList: [{ brand, version: `${major}.0.1.2` }, { brand: "Chromium", version: `${major}.0.1.2` }],
    fullVersion: `${major}.0.1.2`, platform: "macOS", platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
  },
});

/** A Mac whose LaunchServices knows a Google Chrome in a temporary folder, or none. */
function mac(options: { chrome?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omb-launcher-"));
  folders.push(root);
  const app = join(root, "Google Chrome.app");
  const chrome = posix.join(app, "Contents/MacOS/Google Chrome");
  if (options.chrome !== false) {
    mkdirSync(dirname(chrome), { recursive: true });
    writeFileSync(chrome, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Contents", "Info.plist"), "<plist>155.0.1.2</plist>");
  }
  const dataDir = join(root, "data");
  const env = { HOME: root, ...options.env };
  // Only this folder exists for the launcher: the machine running the test may have a Google Chrome of its own.
  const inside = (path: string) => path.startsWith(root) || path.startsWith(options.env?.OMB_CHROME_PATH ?? "\0");
  const real = chromeHost({ dataDir, env, platform: "darwin", arch: "arm64" });
  const host = { ...real, exists: (path: string) => inside(path) && existsSync(path), list: (folder: string) => inside(folder) ? real.list(folder) : [], appForBundleId: () => options.chrome === false ? null : app };
  return { root, app, chrome, dataDir, env, host };
}

function sidecars() {
  return { ensure: vi.fn(async () => {}), forget: vi.fn(), attached: () => false } as unknown as IdentitySidecars & { ensure: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> };
}

function launcher(machine: ReturnType<typeof mac>, overrides: Partial<ConstructorParameters<typeof ChromeLauncher>[0]> = {}) {
  return new ChromeLauncher({
    dataDir: machine.dataDir, env: machine.env, platform: "darwin", arch: "arm64", host: machine.host, engine: () => ({ managed: true }),
    calibrate: vi.fn(async () => identity("155")), screen: async () => ({ width: 1440, height: 900 }), sidecars: sidecars(), log: () => {},
    install: async () => { throw new Error("offline"); },
    // A Mac's launcher is a shell script, which a Windows machine running this test cannot start.
    ...(process.platform === "win32" ? { checkLauncher: async () => {} } : {}),
    ...overrides,
  });
}

const headless = (path: string) => ({ command: "/engine/agent-browser", env: { AGENT_BROWSER_EXECUTABLE_PATH: path, AGENT_BROWSER_HEADLESS: "1" } });

describe("the Chrome launcher", () => {
  it("gives agent-browser a launcher for the installed Google Chrome, with the identity read from that binary", async () => {
    const machine = mac();
    const calibrate = vi.fn(async () => identity("155"));
    const chrome = launcher(machine, { calibrate });
    expect(chrome.env()).toEqual({ AGENT_BROWSER_EXECUTABLE_PATH: chrome.path, AGENT_BROWSER_HIDE_SCROLLBARS: "0" });
    await chrome.ready(headless(chrome.path));
    expect(calibrate).toHaveBeenCalledExactlyOnceWith(machine.chrome, { ...machine.env, HOME: userInfo().homedir });
    const script = readFileSync(chrome.path, "utf8");
    expect(script).toContain(`exec '${machine.chrome}' "$@"`);
    expect(script).toContain(`'--user-agent=${identity("155").userAgent}'`);
    expect(script).toContain("'--screen-info={1440x900}'");
    expect(script).toContain(`HOME='${userInfo().homedir}'`);
    expect(script).toContain("'--use-mock-keychain'");
    expect(chrome.describe()).toBe("Google Chrome 155 (installed)");
    await launcher(machine, { calibrate }).ready(headless(chrome.path));
    expect(calibrate).toHaveBeenCalledOnce();
  });

  it("reads the identity again after Chrome updated itself in place", async () => {
    const machine = mac();
    const calibrate = vi.fn(async () => identity("155"));
    const chrome = launcher(machine, { calibrate });
    await chrome.ready(headless(chrome.path));
    calibrate.mockResolvedValue(identity("156"));
    writeFileSync(join(machine.app, "Contents", "Info.plist"), "<plist>156.0.1.2</plist>");
    utimesSync(join(machine.app, "Contents", "Info.plist"), new Date(), new Date(Date.now() + 60_000));
    await chrome.ready(headless(chrome.path));
    expect(calibrate).toHaveBeenCalledTimes(2);
    expect(readFileSync(chrome.path, "utf8")).toContain("Chrome/156.0.0.0");
    expect(chrome.describe()).toBe("Google Chrome 156 (installed)");
  });

  it("downloads Chrome for Testing where there is no Chrome, and says how far it got while a call waits", async () => {
    const machine = mac({ chrome: false });
    const pin = chromeForTestingPin("darwin", "arm64")!;
    let finish!: () => void;
    const install = vi.fn(async (options: Parameters<typeof installChromeForTesting>[0]) => {
      options.onProgress?.({ received: 52 * 1_048_576, total: pin.bytes });
      await new Promise<void>((resolve) => { finish = resolve; });
      const path = chromeForTestingExecutable(options.dataDir, options.pin);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
      return path;
    });
    const chrome = launcher(machine, { install, readyWaitMs: 20, calibrate: async () => identity("153", "Not_A Brand") });
    expect(chrome.describe()).toBe("Chrome for Testing 153.0.8010.47 (not downloaded yet)");
    await expect(chrome.ready(headless(chrome.path))).rejects.toThrow("Getting the browser ready (52 of 182 MB). Try again in a minute.");
    expect(chrome.describe()).toBe("Chrome for Testing 153.0.8010.47 (downloading: 52 of 182 MB)");
    finish();
    await chrome.prepare();
    await chrome.ready(headless(chrome.path));
    expect(install).toHaveBeenCalledOnce();
    expect(chrome.describe()).toBe("Chrome for Testing 153 (downloaded)");
  });

  it("uses Chrome for Testing when the installed Google Chrome cannot start headless", async () => {
    const machine = mac();
    const install = vi.fn(async (options: Parameters<typeof installChromeForTesting>[0]) => {
      const path = chromeForTestingExecutable(options.dataDir, options.pin);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
      return path;
    });
    const calibrate = vi.fn(async (path: string) => {
      if (path === machine.chrome) throw new Error("the browser exited (1) before it answered");
      return identity("153", "Not_A Brand");
    });
    const chrome = launcher(machine, { install, calibrate });
    await chrome.ready(headless(chrome.path));
    expect(chrome.describe()).toBe("Chrome for Testing 153 (downloaded)");
    expect(readFileSync(chrome.path, "utf8")).toMatch(/chrome-mac-arm64[\\/]Google Chrome for Testing\.app/u);
  });

  it("keeps the engine's own browser, and says why, when Chrome cannot be prepared at all", async () => {
    const named = mkdtempSync(join(tmpdir(), "omb-named-"));
    folders.push(named);
    writeFileSync(join(named, "chrome"), "#!/bin/sh\n", { mode: 0o755 });
    const chrome = launcher(mac({ env: { OMB_CHROME_PATH: join(named, "chrome") } }), {
      calibrate: async () => { throw new Error("the browser's user agent is not Chrome's"); },
    });
    const spec = headless(chrome.path);
    await expect(chrome.ready(spec)).rejects.toThrow("Chrome could not be started (the browser's user agent is not Chrome's). Try again: your next browser call uses the built-in browser.");
    expect(chrome.env()).toEqual({});
    expect(chrome.describe()).toContain("Chrome could not be started");
    expect(existsSync(chrome.path)).toBe(false);
  });

  it("keeps a working launcher when reading a newer binary fails, rather than switch browsers mid-session", async () => {
    const machine = mac();
    const calibrate = vi.fn(async () => identity("155"));
    const chrome = launcher(machine, { calibrate });
    await chrome.ready(headless(chrome.path));
    calibrate.mockRejectedValue(new Error("Chrome crashed"));
    utimesSync(join(machine.app, "Contents", "Info.plist"), new Date(), new Date(Date.now() + 120_000));
    await chrome.ready(headless(chrome.path));
    expect(chrome.env()).toMatchObject({ AGENT_BROWSER_EXECUTABLE_PATH: chrome.path });
    expect(chrome.describe()).toBe("Google Chrome 155 (installed)");
    await chrome.ready(headless(chrome.path));
    expect(calibrate).toHaveBeenCalledTimes(2);
  });

  it("moves the next browser to the time zone the owner's app gives the server later, as the server's own clock moves", async () => {
    const machine = mac({ env: { TZ: "UTC" } });
    const chrome = launcher(machine);
    await chrome.ready(headless(chrome.path));
    expect(readFileSync(chrome.path, "utf8")).toContain("TZ='UTC'");
    (machine.env as NodeJS.ProcessEnv).TZ = "Asia/Jerusalem";
    expect(chrome.env()).toEqual({ AGENT_BROWSER_EXECUTABLE_PATH: chrome.path, AGENT_BROWSER_HIDE_SCROLLBARS: "0" });
    const script = readFileSync(chrome.path, "utf8");
    expect(script).toContain("TZ='Asia/Jerusalem'");
    expect(script).toContain(`'--user-agent=${identity("155").userAgent}'`);
  });

  it("starts the launcher once before any bot needs it, with the person's own home on a Mac whatever HOME the server has", async () => {
    const machine = mac();
    const checkLauncher = vi.fn(async () => {});
    const chrome = launcher(machine, { checkLauncher });
    await chrome.ready(headless(chrome.path));
    expect(checkLauncher).toHaveBeenCalledExactlyOnceWith(chrome.path, { ...machine.env, HOME: userInfo().homedir });
    expect(machine.env.HOME).not.toBe(userInfo().homedir);
  });

  it.skipIf(process.platform === "win32")("keeps the engine's own browser where the data dir cannot run the launcher", async () => {
    const machine = mac();
    const chrome = launcher(machine);
    chmodSync(machine.chrome, 0o644);
    await expect(chrome.ready(headless(chrome.path))).rejects.toThrow(/Chrome could not be started \(the browser launcher does not run here/);
    expect(chrome.env()).toEqual({});
    chmodSync(machine.chrome, 0o755);
  });

  it.skipIf(process.platform === "win32")("counts a launcher check that only ran out of time as running, and still refuses one that fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-launcher-check-"));
    folders.push(root);
    const slow = join(root, "slow.sh"), failing = join(root, "failing.sh");
    // A Cloud machine just after a restart: the launcher starts but answers late.
    writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
    writeFileSync(failing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    await expect(runsLauncher(slow, process.env, 200)).resolves.toBeUndefined();
    await expect(runsLauncher(failing, process.env, 5_000)).rejects.toThrow(/the browser launcher does not run here/);
    chmodSync(slow, 0o644);
    await expect(runsLauncher(slow, process.env, 5_000)).rejects.toThrow(/the browser launcher does not run here/);
  });

  it("changes nothing on OMB_BROWSER_LEGACY_SHELL=1", async () => {
    const machine = mac({ env: { OMB_BROWSER_LEGACY_SHELL: "1", OMB_RESOURCES_PATH: "/Applications/OpenMausBot.app/Contents/Resources" } });
    const calibrate = vi.fn();
    const chrome = launcher(machine, { calibrate });
    expect(chrome.env()).toEqual({});
    await chrome.ready(headless("/bundle/chrome-headless-shell"));
    await chrome.prepare();
    expect(calibrate).not.toHaveBeenCalled();
    expect(chrome.describe()).toBe("the bundled Chromium headless shell (OMB_BROWSER_LEGACY_SHELL=1)");
    expect(readdirSync(machine.root)).not.toContain("data");
  });

  it("gives a started browser its identity, with the person's languages as a list, only when it is this launcher's headless Chrome", async () => {
    const machine = mac({ env: { LANG: "pt_BR.UTF-8" } });
    const attached = sidecars();
    const chrome = launcher(machine, { sidecars: attached });
    await chrome.started("bot-1", headless(chrome.path));
    expect(attached.ensure).not.toHaveBeenCalled();
    await chrome.ready(headless(chrome.path));
    await chrome.started("bot-1", headless(chrome.path));
    expect(attached.ensure).toHaveBeenCalledExactlyOnceWith("bot-1", headless(chrome.path), { ...identity("155"), acceptLanguage: "pt-BR,pt,en-US,en" });
    await chrome.started("bot-2", { command: "/engine/agent-browser", env: { AGENT_BROWSER_EXECUTABLE_PATH: chrome.path } });
    await chrome.started("bot-3", { command: "/engine/agent-browser", env: { ...headless(chrome.path).env, AGENT_BROWSER_AUTO_CONNECT: "1" } });
    await chrome.started("bot-4", headless("/bundle/chrome-headless-shell"));
    expect(attached.ensure).toHaveBeenCalledOnce();
    chrome.stopped("bot-1");
    expect(attached.forget).toHaveBeenCalledWith("bot-1");
  });
});
