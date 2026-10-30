// S4 conformance on real Chrome: navigation, dialogs, downloads, popups, tabs,
// evaluation, waiting, page health, screenshots and the screencast. The
// deadline case marked (t3) is T3 Code's ServerBrowserPage.test.ts, Copyright
// 2026 T3 Tools Inc., used under the MIT License (third_party/t3-code/LICENSE).
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostTimeout } from "../../testing/host-timeout.ts";
import type { CdpPage } from "./page.ts";
import { PICTURE_LIMITS, pictureScale, Screencast, type ScreencastFrame } from "./screencast.ts";
import { FixtureServer } from "./testing/fixtures.ts";
import { CHROME, forbiddenCommands, inPageWorld, startChrome, type RunningChrome } from "./testing/real-chrome.ts";

const suite = CHROME ? describe : describe.skip;

/** A loopback port nothing listens on (port 1 and friends are ports Chrome refuses outright). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function pngSize(data: Buffer): { width: number; height: number } {
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

suite("S4 pages, tabs and page state on real Chrome", () => {
  let fx: FixtureServer;
  let run: RunningChrome;
  let page: CdpPage;
  let pages = 0;
  const extra: RunningChrome[] = [];

  beforeAll(async () => {
    fx = await FixtureServer.start();
    run = await startChrome("pages");
    page = await run.browser.waitForPage();
  }, hostTimeout(180_000));

  afterAll(async () => {
    for (const other of extra) await other.close();
    await run?.close();
    await fx?.close();
  });

  function serve(html: string): string {
    return fx.page(`/q${++pages}`, `<!doctype html><meta charset="utf-8"><title>q${pages}</title>${html}`);
  }

  async function open(html: string, on: CdpPage = page): Promise<string> {
    const url = serve(html);
    await on.navigate(url);
    return url;
  }

  const read = <T = unknown>(expression: string, on: CdpPage = page) => on.evaluate(expression) as Promise<T>;

  it("waits for the readiness asked for and reports the document's status", async () => {
    fx.route("/slow.png", { body: Buffer.from("not really a png"), type: "image/png", delayMs: 2_000 });
    const url = serve(`<p>early</p><img src="/slow.png">`);
    expect(await page.navigate(url, { readiness: "domcontentloaded" })).toEqual({ url, status: 200 });
    expect(await read("document.readyState")).toBe("interactive");
    const started = Date.now();
    await page.navigate(url, { readiness: "load" });
    expect(await read("document.readyState")).toBe("complete");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    await page.navigate(url, { readiness: "networkidle", timeoutMs: 10_000 });
    expect(page.lifecycle.reached("networkidle")).toBe(true);
    fx.route("/gone", { body: "<p>missing</p>", status: 404 });
    expect((await page.navigate(fx.url("/gone"))).status).toBe(404);
  });

  it("names the network error of a failed navigation and refuses other schemes", async () => {
    const dead = `http://127.0.0.1:${await closedPort()}/`;
    await expect(page.navigate(dead)).rejects.toThrow(`Navigation to ${dead} failed: ERR_CONNECTION_REFUSED`);
    await expect(page.navigate("http://127.0.0.1:1/")).rejects.toThrow(/ERR_UNSAFE_PORT/);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://version", "about:config"]) {
      await expect(page.navigate(url)).rejects.toMatchObject({ code: "refused" });
    }
  });

  it("says when an address downloaded instead of opening, and keeps the file", async () => {
    await open("<p>before</p>");
    fx.route("/report.csv", { body: "a,b\n1,2\n", type: "text/csv", headers: { "content-disposition": 'attachment; filename="report.csv"' } });
    await expect(page.navigate(fx.url("/report.csv"))).rejects.toThrow(/downloaded instead/);
    const download = await run.browser.downloads!.finished((entry) => entry.url.endsWith("/report.csv"));
    expect(download).toMatchObject({ state: "completed", fileName: "report.csv", owner: page.targetId });
    expect(download.path).toBe(join(run.browser.downloads!.dir, download.id, "report.csv"));
    expect(readFileSync(download.path!, "utf8")).toBe("a,b\n1,2\n");
  });

  it("saves a download a click starts, under its own folder", async () => {
    fx.route("/notes.txt", { body: "hello download", type: "text/plain", headers: { "content-disposition": 'attachment; filename="../notes.txt"' } });
    await open(`<a id="d" href="/notes.txt">get notes</a>`);
    await page.click({ selector: "#d" });
    const download = await run.browser.downloads!.finished((entry) => entry.url.endsWith("/notes.txt"));
    expect(download.fileName).toMatch(/^_?notes\.txt$/);
    expect(readFileSync(download.path!, "utf8")).toBe("hello download");
    expect(run.browser.downloads!.list(page.targetId).map((entry) => entry.fileName)).toEqual(expect.arrayContaining(["report.csv", download.fileName]));
  });

  it("goes back and forward through documents and fragments, and reloads", async () => {
    const first = await open("<p>first</p>");
    const second = await open(`<p id="n">second</p><script>document.getElementById("n").dataset.loads = String(Number(sessionStorage.loads = (Number(sessionStorage.loads || 0) + 1)))</script>`);
    await page.navigate(`${second}#part`);
    expect(page.url()).toBe(`${second}#part`);
    expect((await page.back()).url).toBe(second);
    expect((await page.back()).url).toBe(first);
    expect((await page.forward()).url).toBe(second);
    // Restored from the back-forward cache: the document was kept, its script did not run again.
    expect(await read(`document.getElementById("n").dataset.loads`)).toBe("1");
    await page.reload();
    expect(await read(`document.getElementById("n").dataset.loads`)).toBe("2");
    await page.navigate("about:blank");
    await expect(page.forward()).rejects.toThrow(/no later page/);
  });

  it("answers alert, confirm and prompt, and refuses other work while one is open", async () => {
    await open(`<button id="a" onclick="alert('note'); document.body.dataset.alerted = 'yes'">alert</button>
      <button id="c" onclick="document.body.dataset.confirmed = String(confirm('sure?'))">confirm</button>
      <button id="p" onclick="document.body.dataset.name = prompt('name?', 'default')">prompt</button><input id="i">`);
    expect((await page.click({ selector: "#p" })).dialog).toBe(true);
    expect(page.dialogs.pending).toMatchObject({ type: "prompt", message: "name?", defaultPrompt: "default" });
    await expect(page.fill({ selector: "#i" }, "x")).rejects.toMatchObject({ code: "dialog-pending" });
    await expect(page.evaluate("1")).rejects.toMatchObject({ code: "dialog-pending" });
    await page.answerDialog({ accept: true, promptText: "Ada" });
    expect((await page.click({ selector: "#c" })).dialog).toBe(true);
    await page.answerDialog({ accept: false });
    expect((await page.click({ selector: "#a" })).dialog).toBe(true);
    await page.answerDialog({ accept: true });
    await page.waitFor({ target: { selector: "body[data-alerted=yes]" }, timeoutMs: 2_000 });
    expect(await read(`[document.body.dataset.name, document.body.dataset.confirmed]`)).toEqual(["Ada", "false"]);
    await expect(page.answerDialog({ accept: true })).rejects.toThrow(/No dialog is open/);
  });

  it("accepts a beforeunload when the agent itself navigates away", async () => {
    await open(`<input id="i"><script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; })</script>`);
    await page.click({ selector: "#i" });
    await page.type(null, "unsaved");
    const next = serve("<p>next page</p>");
    await page.navigate(next);
    expect(page.url()).toBe(next);
    expect(page.dialogs.pending).toBeNull();
  });

  it("keeps a popup in the same profile as a new tab, opener intact", async () => {
    const target = serve(`<p id="p">popup</p>`);
    await open(`<button id="o" onclick="window.child = window.open('${target}', 'kid')">open</button><script>sessionStorage.mark = "opener"</script>`);
    const popupOpened = run.browser.waitForPage((candidate) => candidate.openerId === page.targetId);
    await page.click({ selector: "#o" });
    const popup = await popupOpened;
    await popup.waitFor({ text: "popup", timeoutMs: 5_000 });
    expect(popup.url()).toBe(target);
    expect(await read("window.opener !== null", popup)).toBe(true);
    expect(run.browser.activePage).toBe(popup);
    await page.click({ selector: "#o" });
    expect(run.browser.activePage).toBe(page);
    await popup.close();
    // Chrome reports the closed tab with an event after Target.closeTarget has answered.
    for (const until = Date.now() + hostTimeout(5_000); run.browser.pages().includes(popup) && Date.now() < until;) await page.waitFor({ ms: 25 });
    expect(run.browser.pages()).not.toContain(popup);
  });

  it("closes popups past the tab limit", async () => {
    const limited = await startChrome("limit", { browser: { maxPages: 2 } });
    extra.push(limited);
    const first = await limited.browser.waitForPage();
    let closed = 0;
    limited.browser.onPageClosed(() => closed++);
    // One click opens one popup: Chrome's popup blocker spends the click's activation on the first.
    await open(`<button id="o" onclick="window.open('about:blank')">popup</button>`, first);
    const popup = limited.browser.waitForPage((page) => page.openerId === first.targetId);
    await first.click({ selector: "#o" });
    await popup;
    expect(limited.browser.pages()).toHaveLength(2);
    await first.click({ selector: "#o" });
    for (const until = Date.now() + 10_000; closed < 1 && Date.now() < until;) await first.waitFor({ ms: 50 });
    expect(closed).toBe(1);
    expect(limited.browser.pages()).toHaveLength(2);
  });

  it("opens, lists, fronts and closes tabs; input goes to the tab acted on", async () => {
    const second = await run.browser.newPage(serve(`<button id="b" onclick="this.textContent='two'">tab two</button>`));
    expect(run.browser.pages()).toEqual(expect.arrayContaining([page, second]));
    expect(run.browser.activePage).toBe(second);
    await open(`<button id="b" onclick="this.textContent='one'">tab one</button>`);
    const started = Date.now();
    await page.click({ selector: "#b" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await read(`document.getElementById("b").textContent`)).toBe("one");
    await second.click({ selector: "#b" });
    expect(await read(`document.getElementById("b").textContent`, second)).toBe("two");
    await second.close();
    for (const until = Date.now() + hostTimeout(5_000); run.browser.pages().includes(second) && Date.now() < until;) await page.waitFor({ ms: 25 });
    expect(run.browser.pages()).toEqual([page]);
    await expect(second.click({ selector: "#b" })).rejects.toMatchObject({ code: "closed" });
  });

  it("evaluates in the isolated world unless the page's world is asked for, in any frame", async () => {
    fx.page("/framed", `<!doctype html><p id="t">framed</p><script>window.frameSecret = location.hostname</script>`);
    await open(`<p id="t">top</p><iframe src="/framed"></iframe><iframe src="${fx.crossSiteUrl("/framed")}"></iframe><script>window.secret = 42</script>`);
    await page.waitFor({ ms: 300 });
    expect(await read(`[typeof window.secret, document.getElementById("t").textContent]`)).toEqual(["undefined", "top"]);
    expect(await inPageWorld(() => page.evaluate("window.secret", { world: "page" }))).toBe(42);
    const [same, cross] = page.frames.all().filter((frame) => frame.id !== page.frames.mainFrameId).sort((a) => (a.session === page.session ? -1 : 1));
    expect(await page.evaluate(`document.getElementById("t").textContent + ":" + typeof window.frameSecret`, { frameId: same!.id })).toBe("framed:undefined");
    expect(await inPageWorld(() => page.evaluate("window.frameSecret", { world: "page", frameId: same!.id }))).toBe("127.0.0.1");
    expect(await inPageWorld(() => page.evaluate("window.frameSecret", { world: "page", frameId: cross!.id }))).toBe("localhost");
    expect(await page.evaluate("new Promise((resolve) => setTimeout(() => resolve('later'), 50))")).toBe("later");
    await expect(page.evaluate("throw new TypeError('bad thing')")).rejects.toThrow(/TypeError: bad thing/);
  });

  it("stops an evaluation at its deadline so the page answers the next one (t3)", async () => {
    await open("<p>busy</p>");
    await expect(page.evaluate("for (;;) {}", { timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" });
    expect(await page.evaluate("1 + 1", { timeoutMs: 2_000 })).toBe(2);
    await expect(inPageWorld(() => page.evaluate("for (;;) {}", { world: "page", timeoutMs: 200 }))).rejects.toMatchObject({ code: "timeout" });
    expect(await page.evaluate("2 + 2", { timeoutMs: 2_000 })).toBe(4);
  });

  it("refuses an oversized expression and an oversized result", async () => {
    await expect(page.evaluate(`"${"x".repeat(64_000)}"`)).rejects.toMatchObject({ code: "refused" });
    await expect(page.evaluate(`"y".repeat(70000)`)).rejects.toMatchObject({ code: "result-too-large", detail: { maximumBytes: 64_000 } });
  });

  it("waits for text, elements, their removal, an address and a load state, and says when it gives up", async () => {
    await open(`<p id="gone">soon gone</p><script>
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p id='late'>arrived late</p>"), 300);
      setTimeout(() => document.getElementById("gone").remove(), 500);
      setTimeout(() => history.pushState({}, "", "/done-here"), 400);
    </script>`);
    await page.waitFor({ text: "arrived late", timeoutMs: 3_000 });
    await page.waitFor({ target: { selector: "#late" }, timeoutMs: 3_000 });
    await page.waitFor({ target: { selector: "#gone" }, gone: true, urlIncludes: "done-here", load: "load", timeoutMs: 3_000 });
    const started = Date.now();
    await page.waitFor({ ms: 150 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    await expect(page.waitFor({ text: "never there", timeoutMs: 200 })).rejects.toThrow("Waited 200ms without every condition holding.");
  });

  it("reports failed requests and log lines without the Runtime domain, and cannot see uncaught page errors", async () => {
    fx.route("/api/broken", { body: "{}", type: "application/json", status: 500 });
    const unreachable = `http://127.0.0.1:${await closedPort()}/unreachable`;
    page.takeHealth();
    await open(`<script src="/missing.js"></script><script>
      fetch("/api/broken");
      fetch("${unreachable}").catch(() => {});
      setTimeout(() => { throw new Error("uncaught in page"); }, 10);
      Promise.reject(new Error("unhandled in page"));
    </script>`);
    await page.evaluate(`globalThis.__seen = []; addEventListener("error", (e) => __seen.push(e.message)); addEventListener("unhandledrejection", (e) => __seen.push("rejection"));`);
    await inPageWorld(() => page.evaluate(`setTimeout(() => { throw new Error("thrown after the listener") }, 0)`, { world: "page" }));
    await page.waitFor({ ms: 500 });
    const health = page.takeHealth();
    expect(health.failedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: fx.url("/missing.js"), resourceType: "Script", status: 404, firstParty: true }),
      expect.objectContaining({ url: fx.url("/api/broken"), resourceType: "Fetch", status: 500, method: "GET" }),
      expect.objectContaining({ url: unreachable, status: null, errorText: "net::ERR_CONNECTION_REFUSED" }),
    ]));
    expect(health.log.some((line) => line.level === "error" && /404|500/.test(line.text))).toBe(true);
    expect(health.humanChecks).toEqual([]);
    expect(await page.evaluate("__seen")).toEqual([]);
    expect(page.takeHealth().failedRequests).toEqual([]);
  });

  it("takes pictures one pixel per CSS pixel within the limits a model takes as they are: the viewport, an element and the whole page", async () => {
    await open(`<div id="box" style="margin:40px;width:200px;height:100px;background:red"></div><div style="height:3000px"></div>`);
    expect(await read("[innerWidth, innerHeight]")).toEqual([1280, 720]);
    const viewport = await page.screenshot();
    // The viewport's width: 1280 where scrollbars overlay the page (macOS), less a 15-16 px classic scrollbar elsewhere.
    expect(viewport).toMatchObject({ scale: 1, region: { height: 720 }, width: viewport.region.width, height: 720 });
    expect(viewport.region.width).toBeGreaterThanOrEqual(1_260);
    expect(viewport.region.width).toBeLessThanOrEqual(1_280);
    expect(pngSize(viewport.data)).toEqual({ width: viewport.region.width, height: 720 });
    const element = await page.screenshot({ target: { selector: "#box" } });
    expect(pngSize(element.data)).toEqual({ width: 200, height: 100 });
    const full = await page.screenshot({ fullPage: true });
    // The document's width: 1280 where scrollbars overlay the page (macOS), less a 15-16 px classic scrollbar elsewhere.
    expect(full.region.width).toBeGreaterThanOrEqual(1_260);
    expect(full.region.width).toBeLessThanOrEqual(1_280);
    expect(full.region.height).toBeGreaterThan(3000);
    expect(full.scale).toBe(pictureScale(full.region));
    expect(pngSize(full.data)).toEqual({ width: full.width, height: full.height });
    expect(full.height).toBeLessThanOrEqual(PICTURE_LIMITS.maxHeight);
    expect(full.width * full.height).toBeLessThanOrEqual(PICTURE_LIMITS.maxPixels);
    const retina = await startChrome("retina", { launch: { screen: { width: 1512, height: 982, deviceScaleFactor: 2 } } });
    extra.push(retina);
    const sharp = await retina.browser.waitForPage();
    await sharp.navigate(serve("<p>retina</p>"));
    expect(await sharp.devicePixelRatio()).toBe(2);
    expect(await sharp.evaluate("[innerWidth, innerHeight, screen.width, screen.height]")).toEqual([1280, 720, 1512, 982]);
    const shot = await sharp.screenshot();
    expect(pngSize(shot.data)).toEqual({ width: 1280, height: 720 });
    await sharp.emulateSize({ width: 1280, height: 2400 });
    const tall = await sharp.screenshot();
    expect(tall).toMatchObject({ scale: 0.62, region: { width: 1280, height: 2400 }, width: 794, height: 1488 });
    expect(pngSize(tall.data)).toEqual({ width: 794, height: 1488 });
    await sharp.emulateSize({ width: 390, height: 844 });
    expect(pngSize((await sharp.screenshot()).data)).toEqual({ width: 390, height: 844 });
  });

  it("fits each headless window so its page is exactly the viewport asked for", async () => {
    const fitted = await startChrome("fit", { browser: { viewport: { width: 1366, height: 768 } } });
    extra.push(fitted);
    const first = await fitted.browser.waitForPage();
    await first.navigate(serve("<p>fitted</p>"));
    expect(await first.evaluate("[innerWidth, innerHeight]")).toEqual([1366, 768]);
    const second = await fitted.browser.newPage(serve("<p>second tab</p>"));
    expect(await second.evaluate("[innerWidth, innerHeight]")).toEqual([1366, 768]);
    await first.bringToFront();
    expect(await first.evaluate("[innerWidth, innerHeight]")).toEqual([1366, 768]);
  });

  it("streams screencast frames with paced acks, and stops", async () => {
    await open(`<p id="c">0</p><script>let n = 0; setInterval(() => document.getElementById("c").textContent = String(++n), 30)</script>`);
    const frames: ScreencastFrame[] = [];
    const cast = new Screencast(page.session, (frame) => frames.push(frame));
    await cast.start({ format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 360 });
    await page.waitFor({ ms: 1_000 });
    await cast.stop();
    const count = frames.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(40);
    expect(frames[0]!.data.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(frames[0]!.metadata.deviceWidth).toBe(1280);
    await page.waitFor({ ms: 300 });
    expect(frames.length).toBeLessThanOrEqual(count + 1);
  });

  it("captures what a copy key put on the clipboard, from the isolated world", async () => {
    await open(`<input id="i" value="copy me please">`);
    await page.click({ selector: "#i" });
    await page.press("ControlOrMeta+A");
    await page.press("ControlOrMeta+C");
    expect(await page.takeCopiedText()).toBe("copy me please");
    expect(await page.takeCopiedText()).toBe("");
  });

  it("sent nothing that enables Runtime, binds into pages or evaluates in the page's world uninvited", () => {
    expect(run.trace.length).toBeGreaterThan(100);
    expect(forbiddenCommands()).toEqual([]);
  });
});
