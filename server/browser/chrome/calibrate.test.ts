import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { CdpBrowser } from "../cdp/browser.ts";
import { FakeChrome } from "../testing/fake-chrome.ts";
import { calibrateIdentity, identityFile, loadOrCalibrateIdentity, openOwnPage, type CalibratedIdentity } from "./calibrate.ts";
import { FIRST_START_MS } from "./launch.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "omb-calibrate-test-"));
  folders.push(made);
  return made;
}

const READ: CalibratedIdentity = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  userAgentMetadata: {
    brands: [{ brand: "Chromium", version: "153" }], fullVersionList: [{ brand: "Chromium", version: "153.0.8010.47" }], fullVersion: "153.0.8010.47",
    platform: "macOS", platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
  },
  product: "Chrome/153.0.8010.47",
  fingerprint: "",
  calibratedAt: "2026-10-16T00:00:00.000Z",
};

/** A Chrome whose pages commit but never finish loading. */
class NeverLoads extends FakeChrome {
  override event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === "Page.loadEventFired" || (method === "Page.lifecycleEvent" && params.name === "load")) return;
    super.event(method, params, sessionId);
  }
}

async function firstTab(chrome: FakeChrome) {
  const browser = await CdpBrowser.connect(chrome, { identity: null, headless: true, permissions: false });
  return browser.waitForPage();
}

describe("opening a page of our own", () => {
  const url = "http://127.0.0.1:9/";
  const navigations = (chrome: FakeChrome) => chrome.sent.filter((sent) => sent.method === "Page.navigate").length;

  it("opens it again when Chrome cancels the first navigation", async () => {
    const chrome = new FakeChrome({ navigationErrors: ["net::ERR_ABORTED"] });
    const tab = await firstTab(chrome);
    await openOwnPage(tab, url, 5_000);
    expect(tab.url()).toBe(url);
    expect(navigations(chrome)).toBe(2);
  });

  it("opens it again when Chrome never answers the first navigation", async () => {
    const chrome = new FakeChrome();
    let lost = 1;
    chrome.hang = (method) => method === "Page.navigate" && lost-- > 0;
    const tab = await firstTab(chrome);
    await openOwnPage(tab, url, 200);
    expect(tab.url()).toBe(url);
    expect(navigations(chrome)).toBe(2);
  });

  it("gives up when the second navigation goes unanswered too, and never repeats a page that was slow to load", async () => {
    const silent = new FakeChrome();
    silent.hang = (method) => method === "Page.navigate";
    await expect(openOwnPage(await firstTab(silent), url, 200)).rejects.toThrow(/Page.navigate got no answer/);
    expect(navigations(silent)).toBe(2);
    const slow = new NeverLoads();
    await expect(openOwnPage(await firstTab(slow), url, 200)).rejects.toMatchObject({ code: "timeout", detail: undefined });
    expect(navigations(slow)).toBe(1);
  });

  it("gives up when the second navigation is cancelled too, and never repeats another failure", async () => {
    const twice = new FakeChrome({ navigationErrors: ["net::ERR_ABORTED", "net::ERR_ABORTED"] });
    await expect(openOwnPage(await firstTab(twice), url, 5_000)).rejects.toThrow(/failed: ERR_ABORTED/);
    expect(navigations(twice)).toBe(2);
    const refused = new FakeChrome({ navigationErrors: ["net::ERR_CONNECTION_REFUSED"] });
    await expect(openOwnPage(await firstTab(refused), url, 5_000)).rejects.toThrow(/failed: ERR_CONNECTION_REFUSED/);
    expect(navigations(refused)).toBe(1);
  });
});

describe("reading a Chrome's own identity", () => {
  it.skipIf(process.platform === "win32")("starts the binary headless over a pipe, off the keychain, on the account's real home, and says when it exits", async () => {
    const dir = folder();
    const chrome = join(dir, "chrome");
    writeFileSync(chrome, `#!/bin/sh\n{ printf '%s\\n' "$HOME" "$@"; echo ::end::; } >> '${dir}/runs'\nexit 3\n`, { mode: 0o755 });
    await expect(calibrateIdentity({ executablePath: chrome, host: "desktop", env: { PATH: "/usr/bin:/bin", HOME: "/tmp/not-a-home" }, tmpRoot: dir, handshakeTimeoutMs: 10_000 })).rejects.toThrow(/exited|closed its DevTools pipe/);
    const runs = readFileSync(join(dir, "runs"), "utf8").split("::end::\n").filter(Boolean).map((run) => run.split("\n").filter(Boolean));
    expect(runs.map(([home]) => home)).toEqual(runs.map(() => userInfo().homedir));
    const [launch, ...diagnosis] = runs;
    const args = launch!.slice(1);
    expect(args).toContain("--headless=new");
    expect(args).toContain(process.platform === "darwin" ? "--use-mock-keychain" : "--password-store=basic");
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.filter((arg) => arg.startsWith("--remote-debugging-port"))).toEqual([]);
    expect(diagnosis.map((run) => run.slice(1))).toEqual(process.platform === "linux" ? [["--version"]] : []);
  });

  it.skipIf(process.platform === "win32")("gives the binary's first start, which a calibration always is, two minutes to answer", async () => {
    const dir = folder();
    const chrome = join(dir, "chrome");
    writeFileSync(chrome, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = calibrateIdentity({ executablePath: chrome, host: "desktop", env: { PATH: "/usr/bin:/bin" }, tmpRoot: dir })
        .then(() => "read", (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(FIRST_START_MS - 1_000);
      expect(await Promise.race([outcome, Promise.resolve("still waiting")])).toBe("still waiting");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await outcome).toContain(`within ${FIRST_START_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads it once per binary, and again after the binary changed in place", async () => {
    const dir = folder();
    const app = join(dir, "Google Chrome.app", "Contents");
    mkdirSync(join(app, "MacOS"), { recursive: true });
    const chrome = join(app, "MacOS", "Google Chrome");
    writeFileSync(chrome, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Info.plist"), "<plist>153</plist>");
    const calibrate = vi.fn(async () => ({ ...READ }));
    const options = { executablePath: chrome, host: "desktop" as const };
    expect((await loadOrCalibrateIdentity(dir, options, calibrate)).calibrated).toBe(true);
    expect((await loadOrCalibrateIdentity(dir, options, calibrate)).calibrated).toBe(false);
    expect(calibrate).toHaveBeenCalledOnce();
    const stored = JSON.parse(readFileSync(identityFile(dir, chrome), "utf8")) as CalibratedIdentity;
    expect(stored.product).toBe("Chrome/153.0.8010.47");
    writeFileSync(join(app, "Info.plist"), "<plist>154 with a longer version</plist>");
    expect((await loadOrCalibrateIdentity(dir, options, calibrate)).calibrated).toBe(true);
    expect(calibrate).toHaveBeenCalledTimes(2);
  });
});
