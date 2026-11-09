import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureServer } from "../browser/cdp/testing/fixtures.ts";
import { CHROME, startChrome, type RunningChrome } from "../browser/cdp/testing/real-chrome.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import { captureBrowserClick, replayBrowserClick, type ExclusiveBrowser } from "./browser-replay.ts";

const suite = CHROME ? describe : describe.skip;
suite("sample browser replay on Chrome", () => {
  let fx: FixtureServer, run: RunningChrome;
  beforeAll(async () => { fx = await FixtureServer.start(); run = await startChrome("minimum-ai-replay"); }, hostTimeout(180_000));
  afterAll(async () => { await run?.close(); await fx?.close(); });
  it("moves and permanently deletes only the named sample item", async () => {
    const page = await run.browser.waitForPage();
    const html = readFileSync(new URL("../testing/minimum-ai-browser-fixture.html", import.meta.url), "utf8");
    const url = fx.page("/minimum-ai-fixture", html);
    await page.navigate(url);
    const exclusive = async (work: (session: ExclusiveBrowser) => Promise<void>) => work({
      snapshot: async () => page.snapshot(),
      click: async (ref) => { await page.click({ ref }); },
    });
    const signal = new AbortController().signal, origin = new URL(url).origin;
    const first = await page.snapshot();
    const firstLine = first.tree.split("\n").find((line) => line.includes('"Move Sample Alpha to trash (group: Trash)"'));
    const firstRef = firstLine?.match(/\[ref=(e\d+)\]/)?.[1];
    expect(firstRef).toBeTruthy();
    const recorded = captureBrowserClick(first, `@${firstRef}`);
    await replayBrowserClick(recorded, exclusive, signal);
    for (const name of ["Trash", "Permanently delete Sample Alpha (group: Trash)", "Database"]) {
      await replayBrowserClick({ origin, url, role: "button", name }, exclusive, signal);
    }
    const tree = (await page.snapshot()).tree;
    expect(tree).not.toContain("Move Sample Alpha to trash");
    expect(tree).toContain("Sample Alpha: deleted");
    expect(tree).toContain("Sample Beta");
    expect(tree).toContain("Sample Gamma");
  }, hostTimeout(60_000));
  it("refuses a duplicated target in a real browser without clicking either", async () => {
    const page = await run.browser.waitForPage();
    const url = fx.page("/ambiguous", '<!doctype html><button onclick="this.remove()">Delete sample</button><button onclick="this.remove()">Delete sample</button>');
    await page.navigate(url);
    const exclusive = async (work: (session: ExclusiveBrowser) => Promise<void>) => work({ snapshot: async () => page.snapshot(), click: async (ref) => { await page.click({ ref }); } });
    await expect(replayBrowserClick({ origin: new URL(url).origin, url, role: "button", name: "Delete sample" }, exclusive, new AbortController().signal)).rejects.toThrow(/ambiguous/);
    expect((await page.snapshot()).tree.match(/button "Delete sample"/g)).toHaveLength(2);
  }, hostTimeout(60_000));
});
