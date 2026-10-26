import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { LocalBackend } from "./backends.ts";
import type { ChromeProcess } from "./chrome/launch.ts";
import { ProcessRegistry } from "./chrome/processes.ts";
import { browserRoot, profileDir } from "./chrome/profile.ts";
import { FAKE_IDENTITY, FakeChrome } from "./testing/fake-chrome.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

/** A LocalBackend on a fake Chrome per start, each cancelling its first navigation as Chrome for Testing on Windows can. */
function backend(platform: NodeJS.Platform) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-backends-test-"));
  folders.push(dataDir);
  const chromes: FakeChrome[] = [];
  const local = new LocalBackend({
    dataDir,
    host: "desktop",
    platform,
    binary: async () => ({ path: "/fake/chrome", identity: { ...FAKE_IDENTITY } }),
    screen: async () => ({ width: 1920, height: 1080, deviceScaleFactor: 1 }),
    egressPort: async () => null,
    launch: async () => {
      const chrome = new FakeChrome({ navigationErrors: ["net::ERR_ABORTED"] });
      chromes.push(chrome);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => chrome.onClose(() => resolve({ code: 0, signal: null })));
      const launched: ChromeProcess = {
        pid: 1, argv: [], transport: chrome, version: { product: "Chrome/153.0.8010.12", userAgent: "", protocolVersion: "1.3", revision: "" },
        exited, output: () => "", close: async () => { chrome.exit(); return exited; }, kill: async () => { chrome.exit(); return exited; },
      };
      return launched;
    },
  });
  const open = () => local.open({ key: "bot:warm", mode: "headless", fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: join(dataDir, "downloads") });
  return { open, chromes };
}

describe("a fresh profile's first navigation on Windows", () => {
  it("is taken by a page of our own in a tab of its own, so the bot's first page opens", async () => {
    const { open, chromes } = backend("win32");
    const opened = await open();
    const chrome = chromes[0]!;
    expect(chrome.sent.filter((sent) => sent.method === "Target.createTarget")).toHaveLength(1);
    expect(chrome.sent.filter((sent) => sent.method === "Target.closeTarget")).toHaveLength(1);
    const tabs = opened.browser.pages();
    expect(tabs).toHaveLength(1);
    expect(opened.browser.activePage).toBe(tabs[0]);
    await tabs[0]!.navigate("http://example.test/first");
    expect(tabs[0]!.url()).toBe("http://example.test/first");
    await opened.close();
  });

  it("is left to the bot on a profile that navigated before, and off Windows", async () => {
    const windows = backend("win32");
    await (await windows.open()).close();
    const again = await windows.open();
    expect(windows.chromes[1]!.sent.some((sent) => sent.method === "Target.createTarget" || sent.method === "Page.navigate")).toBe(false);
    await again.close();
    const mac = backend("darwin");
    const opened = await mac.open();
    expect(mac.chromes[0]!.sent.some((sent) => sent.method === "Target.createTarget" || sent.method === "Page.navigate")).toBe(false);
    await expect(opened.browser.pages()[0]!.navigate("http://example.test/first")).rejects.toThrow(/ERR_ABORTED/);
    await opened.close();
  });
});

describe("a local browser's profile folder", () => {
  it("is held from the sweep while Chrome starts, and let go when the start fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-backends-test-"));
    folders.push(dataDir);
    const registry = new ProcessRegistry(browserRoot(dataDir));
    const dir = profileDir(dataDir, "temp:a");
    const held: boolean[] = [];
    const local = new LocalBackend({
      dataDir,
      host: "desktop",
      binary: async () => ({ path: "/fake/chrome", identity: { ...FAKE_IDENTITY } }),
      screen: async () => ({ width: 1920, height: 1080, deviceScaleFactor: 1 }),
      egressPort: async () => { held.push(registry.reserved(dir)); return null; },
      registry,
      launch: async () => { held.push(registry.reserved(dir)); throw new Error("Chrome did not start"); },
    });
    await expect(local.open({ key: "temp:a", mode: "headless", fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: join(dataDir, "downloads") })).rejects.toThrow("Chrome did not start");
    expect(held).toEqual([true, true]);
    expect(registry.reserved(dir)).toBe(false);
  });
});
