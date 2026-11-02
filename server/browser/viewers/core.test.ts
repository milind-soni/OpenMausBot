import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { BrowserService } from "../service.ts";
import type { HoldLimits } from "../hold.ts";
import { FakeBackend, FakeChrome, type FakeDocument } from "../testing/fake-chrome.ts";
import { personUrl } from "../dispatch.ts";
import { ACK_PACE_MS, SETTLE_MS, type ViewerOutput } from "./core.ts";
import { fillPage, MIN_WINDOW_WIDTH, requestedSize, UNATTACHED_VIEWPORT, viewportFor } from "./viewport.ts";

const folders: string[] = [];
const services: BrowserService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.closeAll())); });
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`still ${JSON.stringify(value)} after ${timeoutMs} ms`);
    await sleep(5);
  }
}

const same = (expected: unknown) => (actual: unknown) => JSON.stringify(actual) === JSON.stringify(expected);

const PAGE: FakeDocument = { title: "Page", text: "hello", elements: [{ role: "textbox", name: "Name", selector: "#name", editable: true, box: [10, 10, 200, 30] }] };

type WatchOptions = { owner?: string; size?: { width: number; height: number }; maxWidth?: number; maxHeight?: number; pace?: "hi" | "lo"; ack?: boolean; authPrompts?: boolean; pointer?: boolean };

async function setup({ pageLimit = null, document = PAGE, holdLimits }: { pageLimit?: { width: number; height: number } | null; document?: FakeDocument; holdLimits?: HoldLimits } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-viewers-"));
  folders.push(dataDir);
  const backend = new FakeBackend(() => new FakeChrome({ documents: () => ({ ...document, elements: document.elements.map((element) => ({ ...element })) }) }), { pageLimit });
  const service = new BrowserService({ dataDir, backend: () => backend, maxRunning: 4, idleMs: () => 600_000, takeoverMs: 200, ...(holdLimits ? { holdLimits } : {}) });
  services.push(service);
  const target = { session: "bot-a", key: "bot:a" };
  const call = (name: string, args: Record<string, unknown> = {}) => service.agentRpc(target, "tools/call", { name, arguments: args }) as Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  await call("agent_browser_open", { url: "https://example.com/" });
  const watch = async (options: WatchOptions = {}) => {
    const outputs: ViewerOutput[] = [];
    const viewer = await service.attachViewer(target, { owner: options.owner ?? "local-owner", canOperate: true, maxWidth: options.maxWidth ?? 3200, maxHeight: options.maxHeight ?? 2000, pace: options.pace ?? "hi", authPrompts: options.authPrompts === true, ...(options.pointer === false ? { pointer: false } : {}), ...(options.size ? { size: options.size } : {}) }, (output) => {
      outputs.push(output);
      if (output.type === "frame" && options.ack !== false) output.ack();
    });
    return { viewer, outputs };
  };
  const chrome = () => backend.chrome;
  const page = () => [...chrome().pages.values()].at(-1)!;
  return { service, target, call, watch, chrome, page };
}

describe("the page fills the panel", () => {
  it("is 1280x800 with nobody watching, the viewer's panel shape at a desktop's width at least while one watches, and 1280x800 again when it leaves", async () => {
    const { watch, chrome } = await setup();
    expect(chrome().viewport).toEqual(UNATTACHED_VIEWPORT);
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await until(() => chrome().viewport, same({ width: 1600, height: 1000 }));
    await until(() => outputs, (seen) => seen.some((output) => output.type === "viewport" && output.width === 1600 && output.height === 1000));
    await viewer.input({ type: "resize", width: 1200, height: 900 });
    expect(chrome().viewport).toEqual({ width: 1280, height: 960 });
    await viewer.close();
    await until(() => chrome().viewport, same(UNATTACHED_VIEWPORT));
  });

  it("gives a narrow panel a desktop page of its shape, never a phone's, and no taller than twice its width", async () => {
    const { watch, chrome, call } = await setup();
    const { viewer, outputs } = await watch({ size: { width: 400, height: 750 } });
    await until(() => chrome().viewport, same({ width: 1280, height: 2400 }));
    await until(() => outputs.filter((output) => output.type === "viewport").at(-1), (last) => last?.type === "viewport" && last.width === 1280 && last.height === 2400);
    expect((await call("agent_browser_eval", { expression: "[innerWidth, innerHeight]" })).content[0]?.text).toBe("[1280,2400]");
    await viewer.input({ type: "resize", width: 300, height: 900 });
    expect(chrome().viewport).toEqual({ width: 1280, height: 2560 });
    expect(fillPage({ width: 365, height: 686 })).toEqual({ width: 1280, height: 2406 });
    expect(fillPage({ width: 1440, height: 819 })).toEqual({ width: 1440, height: 819 });
  });

  it("follows the latest request, keeps its size for a collapsed panel, and stops at 3840x2160", async () => {
    const { watch, chrome } = await setup();
    const first = await watch({ size: { width: 1400, height: 900 } });
    const second = await watch({ size: { width: 1000, height: 700 } });
    await until(() => chrome().viewport, same({ width: 1280, height: 896 }));
    await first.viewer.input({ type: "resize", width: 1500, height: 950 });
    expect(chrome().viewport).toEqual({ width: 1500, height: 950 });
    await second.viewer.input({ type: "resize", width: 1800, height: 40 });
    expect(chrome().viewport).toEqual({ width: 1500, height: 950 });
    await second.viewer.input({ type: "resize", width: 9000, height: 9000 });
    expect(chrome().viewport).toEqual({ width: 3840, height: 2160 });
    await second.viewer.close();
    await until(() => chrome().viewport, same({ width: 1500, height: 950 }));
    expect(requestedSize(99, 500)).toBeNull();
    expect(requestedSize(100.4, 100)).toEqual({ width: 100, height: 100 });
  });

  it("waits for the bot's running action before it resizes the page, and lets the viewer in at once", async () => {
    const { watch, chrome, call } = await setup();
    chrome().delay = (method) => (method === "Accessibility.getFullAXTree" ? 800 : 0);
    const snapshot = call("agent_browser_snapshot");
    await sleep(30);
    const started = Date.now();
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(outputs).toContainEqual(expect.objectContaining({ type: "viewport", ...UNATTACHED_VIEWPORT }));
    const resizing = viewer.input({ type: "resize", width: 1200, height: 900 });
    await sleep(100);
    expect(chrome().viewport).toEqual(UNATTACHED_VIEWPORT);
    expect((await snapshot).isError).toBeUndefined();
    await resizing;
    await until(() => chrome().viewport, same({ width: 1280, height: 960 }));
  });

  it("never makes a window larger than its screen: a filled panel keeps its shape, emulated past the screen, a set size its width", async () => {
    const { watch, chrome, page } = await setup({ pageLimit: { width: 1440, height: 757 } });
    expect(chrome().viewport).toEqual({ width: 1211, height: 757 });
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await until(() => chrome().viewport, same({ width: 1211, height: 757 }));
    await viewer.input({ type: "resize", width: 400, height: 750 });
    expect(chrome().viewport).toEqual({ width: 1280, height: 757 });
    expect(page().emulated).toEqual({ width: 1280, height: 2400 });
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 1280, height: 2400 });
    await viewer.input({ type: "resize", width: 2000, height: 800 });
    expect(chrome().viewport).toEqual({ width: 1440, height: 576 });
    expect(page().emulated).toBeNull();
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "tablet" } });
    expect(chrome().viewport).toEqual({ width: 820, height: 757 });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    expect(chrome().viewport).toEqual({ width: MIN_WINDOW_WIDTH, height: 757 });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Emulation.setDeviceMetricsOverride", params: expect.objectContaining({ width: 390, height: 757 }) }));
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 390, height: 757 });
    expect(chrome().window.height).toBeLessThanOrEqual(757 + 143);
  });

  it("resizes the real window, so a page narrower than any window comes from a preset only, emulated", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer } = await watch({ size: { width: 1600, height: 1000 } });
    expect(chrome().sentTo(page()).some((sent) => sent.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "tablet" } });
    expect(chrome().viewport).toEqual({ width: 820, height: 1180 });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    expect(chrome().viewport).toEqual({ width: MIN_WINDOW_WIDTH, height: 844 });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Emulation.setDeviceMetricsOverride", params: expect.objectContaining({ width: 390, height: 844, deviceScaleFactor: 2, mobile: false }) }));
    await viewer.input({ type: "viewport", setting: { mode: "fill" } });
    expect(chrome().viewport).toEqual({ width: 1600, height: 1000 });
    expect(chrome().sentTo(page()).some((sent) => sent.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    expect(viewportFor({ mode: "preset", preset: "phone", landscape: true }, null)).toEqual({ width: 844, height: 390 });
  });

  it("ends a drag on a still of the final size, though Chromium sends no frame for it", async () => {
    const { watch } = await setup();
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await sleep(SETTLE_MS + 50);
    const before = outputs.length;
    for (const width of [1500, 1400, 1300]) await viewer.input({ type: "resize", width, height: 900 });
    await sleep(SETTLE_MS + 100);
    const stills = outputs.slice(before).filter((output): output is Extract<ViewerOutput, { type: "frame" }> => output.type === "frame" && output.still);
    expect(stills).toHaveLength(1);
    expect(stills[0]!.metadata).toMatchObject({ deviceWidth: 1300, deviceHeight: 900 });
  });

  it("leaves the page of the person holding the browser alone when another view opens", async () => {
    const { watch, chrome } = await setup();
    const holder = await watch({ size: { width: 1400, height: 900 } });
    await holder.viewer.input({ type: "takeControl" });
    const other = await watch({ size: { width: 700, height: 1000 } });
    expect(chrome().viewport).toEqual({ width: 1400, height: 900 });
    expect(other.outputs).toContainEqual(expect.objectContaining({ type: "viewport", width: 1400, height: 900 }));
    await other.viewer.close();
    expect(chrome().viewport).toEqual({ width: 1400, height: 900 });
  });

  it("tells viewers the page a window held to its screen leaves a tab with a taller bar", async () => {
    const { watch, chrome, page } = await setup({ pageLimit: { width: 1440, height: 757 } });
    page().bar = 56;
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await viewer.input({ type: "resize", width: 2000, height: 1100 });
    expect(chrome().window.height).toBe(757 + 143);
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 1376, height: 701 });
  });

  it("emulates a page narrower than any window on a tab that opens later too", async () => {
    const { watch, chrome, call } = await setup();
    const { viewer } = await watch();
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await viewer.input({ type: "releaseControl" });
    expect((await call("agent_browser_tabs", { action: "new" })).isError).toBeUndefined();
    const opened = [...chrome().pages.values()].at(-1)!;
    await until(() => opened.emulated ?? null, same({ width: 390, height: 844 }));
    const resizes = () => chrome().sent.filter((sent) => sent.method === "Browser.setWindowBounds").length;
    const before = resizes();
    expect((await call("agent_browser_tabs", { action: "switch", tab: "t1" })).isError).toBeUndefined();
    expect(resizes()).toBe(before);
    expect(chrome().window.width).toBe(MIN_WINDOW_WIDTH);
  });
});

describe("a viewer's screencast", () => {
  it("is JPEG at quality 70, as large as the viewer can show, from its own session", async () => {
    const { watch, chrome } = await setup();
    const { outputs } = await watch({ maxWidth: 3200, maxHeight: 2000 });
    const started = chrome().sent.filter((sent) => sent.method === "Page.startScreencast");
    expect(started.at(-1)).toMatchObject({ params: { format: "jpeg", quality: 70, maxWidth: 3200, maxHeight: 2000 } });
    expect(started.at(-1)!.sessionId).toMatch(/^V/);
    await sleep(20);
    expect(outputs.some((output) => output.type === "frame")).toBe(true);
  });

  it("acks each frame no sooner than its pace after it arrived, and not before the viewer acked it", async () => {
    const { watch, chrome, page } = await setup();
    const { outputs } = await watch({ ack: false });
    await sleep(20);
    const frame = outputs.find((output): output is Extract<ViewerOutput, { type: "frame" }> => output.type === "frame" && !output.still)!;
    await sleep(ACK_PACE_MS.hi + 20);
    const acks = () => chrome().sent.filter((sent) => sent.method === "Page.screencastFrameAck").length;
    expect(acks()).toBe(0);
    const acked = Date.now();
    frame.ack();
    await sleep(10);
    expect(acks()).toBe(1);
    expect(Date.now() - acked).toBeLessThan(ACK_PACE_MS.hi);
    expect(page().screencasts.size).toBe(1);
  });

  it("drops to half size at quality 50 while the person scrolls, then sends a sharp still once it settles", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch();
    await viewer.input({ type: "takeControl" });
    const stillsBefore = outputs.filter((output) => output.type === "frame" && output.still).length;
    await viewer.input({ type: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 300 });
    for (let i = 0; i < 4; i++) {
      chrome().paint(page());
      await sleep(15);
    }
    const restarts = chrome().sent.filter((sent) => sent.method === "Page.startScreencast").map((sent) => sent.params);
    expect(restarts).toContainEqual(expect.objectContaining({ quality: 50, maxWidth: 1600, maxHeight: 1000 }));
    await sleep(SETTLE_MS + 100);
    expect(chrome().sent.filter((sent) => sent.method === "Page.startScreencast").at(-1)?.params).toMatchObject({ quality: 70, maxWidth: 3200 });
    expect(outputs.filter((output) => output.type === "frame" && output.still).length).toBe(stillsBefore + 1);
  });

  it("restarts at a bigger frame cap in place, so the person keeps the browser they hold", async () => {
    const { service, target, watch, chrome } = await setup();
    const { viewer, outputs } = await watch({ maxWidth: 2400, maxHeight: 1600, size: { width: 1200, height: 800 } });
    await viewer.input({ type: "takeControl" });
    const stills = () => outputs.filter((output) => output.type === "frame" && output.still).length;
    const before = stills();
    await viewer.input({ type: "frameCap", maxWidth: 3024, maxHeight: 1800 });
    const lastStart = () => chrome().sent.filter((sent) => sent.method === "Page.startScreencast").at(-1)?.params;
    expect(lastStart()).toMatchObject({ maxWidth: 3024, maxHeight: 1800 });
    expect(stills()).toBe(before + 1);
    expect(service.heldBy(target.session)).toBe("local-owner");
    await viewer.input({ type: "frameCap", maxWidth: 99_999, maxHeight: 99_999 });
    expect(lastStart()).toMatchObject({ maxWidth: 7680, maxHeight: 4320 });
  });

  it("stops every screencast on the tab while the bot takes a screenshot, then starts them again", async () => {
    const { service, target, watch, chrome } = await setup();
    await watch();
    const before = chrome().sent.length;
    await service.agentRpc(target, "tools/call", { name: "agent_browser_screenshot", arguments: {} });
    const order = chrome().sent.slice(before).map((sent) => sent.method).filter((method) => ["Page.stopScreencast", "Page.captureScreenshot", "Page.startScreencast"].includes(method));
    expect(order.indexOf("Page.stopScreencast")).toBeLessThan(order.indexOf("Page.captureScreenshot"));
    expect(order.lastIndexOf("Page.startScreencast")).toBeGreaterThan(order.indexOf("Page.captureScreenshot"));
  });
});

describe("viewers of one browser", () => {
  it("shows a viewer that does not hold the browser no frames, tabs or address while another holds it, and ignores its sizes", async () => {
    const { watch, chrome } = await setup();
    const holder = await watch({ size: { width: 1400, height: 900 } });
    const other = await watch({ owner: "phone-session", size: { width: 1000, height: 700 } });
    const beforeTake = other.outputs.length;
    await holder.viewer.input({ type: "takeControl" });
    expect(other.outputs.slice(beforeTake)).toContainEqual(expect.objectContaining({ type: "control", controller: "another-viewer", held: true, owned: false }));
    const seen = other.outputs.length;
    await other.viewer.input({ type: "resize", width: 1100, height: 800 });
    expect(chrome().viewport).toEqual({ width: 1280, height: 896 });
    await holder.viewer.input({ type: "navigate", url: "example.org/next" });
    await sleep(30);
    const later = other.outputs.slice(seen);
    expect(later.filter((output) => ["frame", "tabs", "url"].includes(output.type))).toEqual([]);
    await holder.viewer.input({ type: "releaseControl" });
    await sleep(30);
    expect(other.outputs.slice(seen).some((output) => output.type === "frame")).toBe(true);
  });

  it("keeps the picture in picture of the person holding the browser playing, and shows other people's views nothing", async () => {
    const { service, target, watch, chrome, page } = await setup();
    const panel = await watch();
    const passive = async (owner: string) => {
      const outputs: ViewerOutput[] = [];
      await service.attachViewer(target, { owner, canOperate: false, maxWidth: 1280, maxHeight: 1280 }, (output) => {
        outputs.push(output);
        if (output.type === "frame") output.ack();
      });
      return outputs;
    };
    const pip = await passive("local-owner");
    const elsewhere = await passive("phone-session");
    await panel.viewer.input({ type: "takeControl" });
    await sleep(20);
    const [pipBefore, elsewhereBefore] = [pip.length, elsewhere.length];
    chrome().paint(page());
    await sleep(20);
    expect(pip.slice(pipBefore).some((output) => output.type === "frame")).toBe(true);
    expect(elsewhere.slice(elsewhereBefore).some((output) => output.type === "frame")).toBe(false);
  });

  it("asks the person holding the browser for an HTTP sign-in, and answers the page with what they typed", async () => {
    const { service, target, watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch({ authPrompts: true });
    await viewer.input({ type: "takeControl" });
    const session = chrome().sent.find((sent) => sent.method === "Fetch.enable")?.sessionId;
    expect(session).toBeTruthy();
    chrome().event("Fetch.authRequired", { requestId: "auth-1", authChallenge: { source: "Server", origin: "https://intranet.example", scheme: "basic", realm: "Staff" } }, session!);
    await sleep(10);
    const prompt = outputs.find((output): output is Extract<ViewerOutput, { type: "authPrompt" }> => output.type === "authPrompt");
    expect(prompt).toMatchObject({ id: "auth-1", origin: "https://intranet.example", realm: "Staff" });
    await viewer.input({ type: "authAnswer", tabId: prompt!.tabId, id: prompt!.id, username: "ada", password: "secret" });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Fetch.continueWithAuth", params: { requestId: "auth-1", authChallengeResponse: { response: "ProvideCredentials", username: "ada", password: "secret" } } }));
    expect(service.heldBy(target.session)).toBe("local-owner");
  });

  it("names each HTTP sign-in by tab and challenge, and gives the person's answer only to the one they were shown", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch({ authPrompts: true });
    await viewer.input({ type: "takeControl" });
    const first = page();
    await viewer.input({ type: "tabNew", url: "https://second.example/" });
    await sleep(30);
    const second = page();
    const fetchSession = (tab: typeof first) => chrome().sentTo(tab).find((sent) => sent.method === "Fetch.enable")!.sessionId!;
    const challenge = (tab: typeof first, requestId: string, origin: string, realm: string) =>
      chrome().event("Fetch.authRequired", { requestId, authChallenge: { source: "Server", origin, scheme: "basic", realm } }, fetchSession(tab));
    challenge(first, "x-1", "http://x.example", "X");
    await sleep(10);
    challenge(second, "y-1", "http://y.example", "Y");
    await sleep(10);
    const prompts = () => outputs.filter((output): output is Extract<ViewerOutput, { type: "authPrompt" }> => output.type === "authPrompt");
    const shown = prompts().at(-1)!;
    expect(shown).toMatchObject({ id: "y-1", origin: "http://y.example", realm: "Y" });
    expect(outputs).toContainEqual({ type: "authPromptClosed", id: "x-1" });
    const answers = () => chrome().sent.filter((sent) => sent.method === "Fetch.continueWithAuth");
    await viewer.input({ type: "authAnswer", tabId: shown.tabId, id: "x-1", username: "y-user", password: "y-password" });
    expect(answers()).toEqual([]);
    expect(prompts().at(-1)).toMatchObject({ id: "y-1" });
    await viewer.input({ type: "authAnswer", tabId: shown.tabId, id: "y-1", username: "y-user", password: "y-password" });
    expect(answers()).toEqual([expect.objectContaining({ params: { requestId: "y-1", authChallengeResponse: { response: "ProvideCredentials", username: "y-user", password: "y-password" } } })]);
    expect(chrome().sentTo(second)).toContainEqual(expect.objectContaining({ method: "Fetch.continueWithAuth" }));
    expect(prompts().at(-1)).toMatchObject({ id: "x-1", origin: "http://x.example" });
  });

  it("cancels an HTTP sign-in at once when no one watching can answer it, so the site's refusal shows", async () => {
    const { watch, chrome, page } = await setup();
    const { outputs } = await watch();
    const session = chrome().sent.find((sent) => sent.method === "Fetch.enable")?.sessionId;
    chrome().event("Fetch.authRequired", { requestId: "auth-2", authChallenge: { source: "Server", origin: "https://intranet.example", scheme: "basic", realm: "Staff" } }, session!);
    await sleep(10);
    expect(outputs.some((output) => output.type === "authPrompt")).toBe(false);
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Fetch.continueWithAuth", params: { requestId: "auth-2", authChallengeResponse: { response: "CancelAuth" } } }));
  });

  it("takes only web addresses from a person, never credentials or other schemes", () => {
    expect(personUrl("example.com")).toBe("https://example.com/");
    expect(personUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
    for (const refused of ["javascript:alert(1)", "file:///etc/passwd", "https://a:b@example.com", "data:text/html,x", "https://example.com/\nx"]) expect(personUrl(refused)).toBeNull();
  });
});

describe("one person's hold, across their views", () => {
  it("carries on in their next view after their stream dropped, and ends when none comes back in time", async () => {
    const { service, target, watch } = await setup({ holdLimits: { graceMs: 150, idleMs: 60_000 } });
    const phone = await watch();
    await phone.viewer.input({ type: "takeControl" });
    await phone.viewer.close({ dropped: true });
    expect(service.heldBy(target.session)).toBe("local-owner");
    const reopened = await watch();
    expect(reopened.viewer.controlState()).toMatchObject({ controller: "you", held: true, owned: true, controlling: true });
    await reopened.viewer.close({ dropped: true });
    await sleep(60);
    expect(service.heldBy(target.session)).toBe("local-owner");
    await until(() => service.heldBy(target.session), (owner) => owner === null);
  });

  it("lets another view of theirs take it over or hand it back, and refuses another person both", async () => {
    const { service, target, watch } = await setup();
    const phone = await watch();
    const laptop = await watch();
    const stranger = await watch({ owner: "someone-else" });
    await phone.viewer.input({ type: "takeControl" });
    expect(laptop.viewer.controlState()).toMatchObject({ controller: "agent", held: true, owned: true, controlling: false });
    expect(stranger.viewer.controlState()).toMatchObject({ controller: "another-viewer", held: true, owned: false, controlling: false });
    await stranger.viewer.input({ type: "takeControl" });
    await stranger.viewer.input({ type: "releaseControl" });
    expect(service.heldBy(target.session)).toBe("local-owner");
    await laptop.viewer.input({ type: "takeControl" });
    expect(laptop.viewer.controlState()).toMatchObject({ controller: "you", controlling: true });
    expect(phone.viewer.controlState()).toMatchObject({ controller: "agent", owned: true, controlling: false });
    await phone.viewer.input({ type: "releaseControl" });
    expect(service.heldBy(target.session)).toBeNull();
  });

  it("ends a kept hold its person stopped using, while every key they type keeps it", async () => {
    const { service, target, watch } = await setup({ holdLimits: { graceMs: 60_000, idleMs: 250 } });
    const { viewer } = await watch();
    await viewer.input({ type: "takeControl" });
    await sleep(150);
    await viewer.input({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    await viewer.input({ type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 });
    await sleep(150);
    expect(service.heldBy(target.session)).toBe("local-owner");
    await until(() => service.heldBy(target.session), (owner) => owner === null);
    expect(viewer.controlState()).toMatchObject({ controller: "unclaimed", held: false });
  });
});

describe("what the panel shows besides the page", () => {
  const mainSession = (sent: Array<{ method: string; sessionId: string | null }>) => sent.find((entry) => entry.method === "Page.enable" && entry.sessionId?.startsWith("S"))?.sessionId ?? null;

  it("offers the page's file picker to the person holding the browser only, under a new id when control moves", async () => {
    const { service, target, watch, chrome, page } = await setup();
    const first = await watch();
    const second = await watch();
    await first.viewer.input({ type: "takeControl" });
    const session = mainSession(chrome().sentTo(page()));
    chrome().event("Page.fileChooserOpened", { frameId: page().targetId, mode: "selectMultiple", backendNodeId: 1 }, session!);
    await sleep(20);
    const offered = first.outputs.find((output): output is Extract<ViewerOutput, { type: "fileChooser" }> => output.type === "fileChooser");
    expect(offered).toMatchObject({ multiple: true, accept: "" });
    expect(second.outputs.some((output) => output.type === "fileChooser")).toBe(false);
    expect(await service.answerFileChooser(target.session, "someone-else", offered!.id, [])).toBe(false);
    await first.viewer.input({ type: "releaseControl" });
    await second.viewer.input({ type: "takeControl" });
    await sleep(20);
    expect(first.outputs).toContainEqual({ type: "fileChooserClosed", id: offered!.id });
    const reoffered = second.outputs.find((output): output is Extract<ViewerOutput, { type: "fileChooser" }> => output.type === "fileChooser");
    expect(reoffered?.id).not.toBe(offered!.id);
    expect(await service.answerFileChooser(target.session, "local-owner", offered!.id, [])).toBe(false);
    expect(await service.answerFileChooser(target.session, "local-owner", reoffered!.id, [])).toBe(true);
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "DOM.setFileInputFiles", params: { files: [], backendNodeId: 1 } }));
    await sleep(20);
    expect(second.outputs).toContainEqual({ type: "fileChooserClosed", id: reoffered!.id });
  });

  it("zooms as Chrome does: the page lays out in fewer CSS pixels drawn larger, and the window keeps its size", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "zoom", factor: 1.25 });
    expect(chrome().viewport).toEqual({ width: 1600, height: 1000 });
    expect(chrome().sentTo(page())).toContainEqual(expect.objectContaining({ method: "Emulation.setDeviceMetricsOverride", params: { width: 1280, height: 800, deviceScaleFactor: 2.5, mobile: false } }));
    expect(outputs.at(-2)).toEqual({ type: "viewport", width: 1280, height: 800, setting: { mode: "fill" }, zoom: 1.25 });
    await viewer.input({ type: "zoom", factor: 9 });
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 320, height: 200, zoom: 5 });
    await viewer.input({ type: "zoom", factor: 1 });
    expect(chrome().sentTo(page()).at(-1)?.method).not.toBe("Emulation.setDeviceMetricsOverride");
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 1600, height: 1000, zoom: 1 });
  });

  it("zooms the tabs that open later too, the person's and the page's own, so input still maps onto them", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer, outputs } = await watch({ size: { width: 1600, height: 1000 } });
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "zoom", factor: 1.25 });
    const zoomed = { method: "Emulation.setDeviceMetricsOverride", params: { width: 1280, height: 800, deviceScaleFactor: 2.5, mobile: false } };
    await viewer.input({ type: "tabNew", url: "https://example.org/" });
    await sleep(30);
    const added = page();
    expect(chrome().sentTo(added)).toContainEqual(expect.objectContaining(zoomed));
    const popup = chrome().popup(added, "https://example.net/");
    await sleep(30);
    expect(chrome().sentTo(popup)).toContainEqual(expect.objectContaining(zoomed));
    expect(outputs.filter((output) => output.type === "viewport").at(-1)).toMatchObject({ width: 1280, height: 800, zoom: 1.25 });
  });

  it("keeps a zoom applied while a scaled still is being taken, which Chrome would otherwise undo when it ends", async () => {
    const { service, target, watch, chrome, page } = await setup();
    const panel = await watch({ size: { width: 1500, height: 900 }, maxWidth: 3000, maxHeight: 1800 });
    await panel.viewer.input({ type: "takeControl" });
    const pip = await service.attachViewer(target, { owner: "local-owner", canOperate: false, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      if (output.type === "frame") output.ack();
    });
    chrome().delay = (method) => (method === "Page.captureScreenshot" ? 150 : 0);
    const clipped = () => chrome().sent.filter((sent) => sent.method === "Page.captureScreenshot" && sent.params.clip).length;
    const before = clipped();
    const still = pip.pushStill();
    await until(clipped, (count) => count > before);
    await panel.viewer.input({ type: "zoom", factor: 1.5 });
    await still;
    expect(page().emulated).toEqual({ width: 1000, height: 600 });
  });

  it("sizes a still by the zoom the page is drawn at, not by one still being applied", async () => {
    const { watch, chrome } = await setup();
    const panel = await watch({ size: { width: 1500, height: 900 }, maxWidth: 3000, maxHeight: 1800 });
    await panel.viewer.input({ type: "takeControl" });
    chrome().delay = (method) => (method === "Emulation.setDeviceMetricsOverride" ? 150 : 0);
    const zooming = panel.viewer.input({ type: "zoom", factor: 1.5 });
    await until(() => chrome().sent.some((sent) => sent.method === "Emulation.setDeviceMetricsOverride"), Boolean);
    const clipped = () => chrome().sent.filter((sent) => sent.method === "Page.captureScreenshot" && sent.params.clip).length;
    const before = clipped();
    await panel.viewer.pushStill();
    expect(clipped()).toBe(before);
    await zooming;
  });

  it("leaves a zoomed tab's window alone when the bot brings that tab back to the front", async () => {
    const { watch, chrome, call } = await setup();
    const { viewer } = await watch({ size: { width: 1600, height: 1000 } });
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "zoom", factor: 1.25 });
    await viewer.input({ type: "releaseControl" });
    expect((await call("agent_browser_tabs", { action: "new" })).isError).toBeUndefined();
    const opened = [...chrome().pages.values()].at(-1)!;
    await until(() => opened.emulated ?? null, same({ width: 1280, height: 800 }));
    const resizes = () => chrome().sent.filter((sent) => sent.method === "Browser.setWindowBounds").length;
    const before = resizes();
    expect((await call("agent_browser_tabs", { action: "switch", tab: "t1" })).isError).toBeUndefined();
    expect(resizes()).toBe(before);
    expect(chrome().viewport).toEqual({ width: 1600, height: 1000 });
  });

  it("shows a page's dialog only to the person holding the browser while someone holds it", async () => {
    const { watch, chrome, page } = await setup();
    const holder = await watch();
    const other = await watch({ owner: "phone-session" });
    await holder.viewer.input({ type: "takeControl" });
    chrome().event("Page.javascriptDialogOpening", { type: "alert", message: "Your one-time code is 918273", defaultPrompt: "", url: "https://example.com/" }, mainSession(chrome().sentTo(page()))!);
    await sleep(20);
    const control = (outputs: ViewerOutput[]) => outputs.filter((output) => output.type === "control").at(-1);
    expect(control(holder.outputs)).toMatchObject({ controller: "you", dialog: { type: "alert", message: "Your one-time code is 918273" } });
    expect(control(other.outputs)).toMatchObject({ controller: "another-viewer", dialog: null });
  });

  it("refuses a zoom from a viewer that does not hold the browser", async () => {
    const { watch, chrome, page } = await setup();
    const { viewer } = await watch({ size: { width: 1600, height: 1000 } });
    await viewer.input({ type: "zoom", factor: 2 });
    expect(chrome().sentTo(page()).some((sent) => sent.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
  });

  it("tells viewers where the tab in front is, whether it loads, and where its history goes", async () => {
    const { watch } = await setup();
    const { viewer, outputs } = await watch();
    await sleep(20);
    expect(outputs.filter((output) => output.type === "nav").at(-1)).toMatchObject({ url: "https://example.com/", canGoBack: true, canGoForward: false, loading: false });
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "history", delta: -1 });
    await sleep(30);
    expect(outputs.filter((output) => output.type === "nav").at(-1)).toMatchObject({ url: "about:blank", canGoBack: false, canGoForward: true });
  });
});

