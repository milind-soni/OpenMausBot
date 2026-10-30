// People's views of a bot's browser on real Chrome: the page fills the panel at the screen's real scale, frames wait
// for acknowledgements, the bot's clicks land where they aim while people watch, no window outgrows its screen, and a
// phone's v1 session matches the golden recorded on agent-browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostTimeout } from "../../testing/host-timeout.ts";
import { FixtureServer } from "../cdp/testing/fixtures.ts";
import { CHROME } from "../cdp/testing/real-chrome.ts";
import { fitPage, pageLimit, type ScreenSpec } from "../chrome/flags.ts";
import type { BrowserTarget } from "../service.ts";
import { jpegSize, startService, until, type RealService } from "../testing/real-service.ts";
import type { Viewer, ViewerOptions, ViewerOutput } from "./core.ts";
import { LiveV1 } from "./live-v1.ts";
import { v1Differences, v1StepShown } from "./testing/v1-compare.ts";
import { normalizeV1, runV1Session, startV1Pages } from "./testing/v1-session.ts";

const suite = CHROME ? describe : describe.skip;

/** A page that keeps painting, so a screencast keeps sending frames. */
const ANIMATED = `<!doctype html><title>animated</title><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:60px;height:60px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div><div style="height:4000px"></div>`;

/** Buttons A and B swap places on a page taller than 1500 CSS pixels, or once /state says so; a click notes the page's size. */
const SWAP = `<!doctype html><title>swap</title><style>
body{margin:0} button{position:absolute;left:100px;width:300px;height:120px;font-size:30px}
#a{top:100px} #b{top:300px}
@media (min-height: 1500px) { #a{top:300px} #b{top:100px} }
body.swapped #a{top:300px} body.swapped #b{top:100px}
</style>
<button id="a" onclick="document.body.dataset.clicked='a:'+innerWidth+'x'+innerHeight">A</button>
<button id="b" onclick="document.body.dataset.clicked='b:'+innerWidth+'x'+innerHeight">B</button>
<script>setInterval(async () => { if (await (await fetch("/state", { cache: "no-store" })).text() === "swap") document.body.classList.add("swapped"); }, 10);</script>`;

/** A page taller than its viewport whose Low button and field sit where only a tall viewport shows them; a press notes where it landed. */
const TALL = `<!doctype html><title>tall</title><style>body{margin:0;height:4000px}</style>
<button id="low" style="position:absolute;left:600px;top:1950px;width:200px;height:100px">Low</button>
<input id="field" aria-label="Field" style="position:absolute;left:100px;top:2150px;width:300px">
<script>addEventListener("mousedown", (event) => { document.title = "at " + event.clientX + "," + event.clientY + " on " + (event.target.id || event.target.tagName) + " of " + innerWidth + "x" + innerHeight; });</script>`;

const SCREEN: ScreenSpec = { width: 2560, height: 1600, deviceScaleFactor: 2 };

/** Width and height from a PNG's header. */
const pngSize = (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) });

interface Seen { width: number; height: number; still: boolean; at: number }

suite("viewers of the new browser on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let page: string;
  let swap: string;
  let state = "still";
  let sessions = 0;

  beforeAll(async () => {
    fx = await FixtureServer.start();
    page = fx.page("/animated", ANIMATED);
    swap = fx.page("/swap", SWAP);
    fx.route("/state", () => ({ body: state, type: "text/plain" }));
    real = await startService({ screen: SCREEN });
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
  });

  async function opened(url = page): Promise<BrowserTarget> {
    const target = { session: `viewers-${++sessions}`, key: `bot:viewers-${sessions}` };
    const result = await real.call(target, "agent_browser_open", { url });
    expect(result.isError, real.text(result)).toBeUndefined();
    return target;
  }

  async function watch(target: BrowserTarget, options: Partial<ViewerOptions>, { ack = true } = {}): Promise<{ viewer: Viewer; frames: Seen[]; outputs: ViewerOutput[] }> {
    const frames: Seen[] = [];
    const outputs: ViewerOutput[] = [];
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 3200, maxHeight: 2000, ...options }, (output) => {
      if (output.type !== "frame") {
        outputs.push(output);
        return;
      }
      frames.push({ ...jpegSize(output.data), still: output.still, at: Date.now() });
      if (ack) output.ack();
    });
    return { viewer, frames, outputs };
  }

  const pageSize = (target: BrowserTarget) => real.peek<[number, number, number]>(target, "[innerWidth, innerHeight, devicePixelRatio]");
  const same = (expected: unknown[]) => (actual: unknown[]) => JSON.stringify(actual) === JSON.stringify(expected);

  it("fills the panel: the page takes the viewer's shape at a desktop's width, frames come at the screen's scale, and 1280x800 returns when it leaves", async () => {
    const target = await opened();
    expect(await pageSize(target)).toEqual([1280, 800, 2]);
    const { viewer, frames } = await watch(target, { size: { width: 1600, height: 1000 } });
    await until(() => pageSize(target), same([1600, 1000, 2]));
    await until(() => frames.at(-1), (frame) => frame?.width === 3200 && frame.height === 2000);
    await viewer.input({ type: "resize", width: 1200, height: 900 });
    await until(() => pageSize(target), same([1280, 960, 2]));
    await until(() => frames.at(-1), (frame) => frame?.width === 2560 && frame.height === 1920);
    await viewer.close();
    await until(() => pageSize(target), same([1280, 800, 2]));
  }, hostTimeout(90_000));

  it("follows the viewer that asked last, and a preset narrower than any window is emulated", async () => {
    const target = await opened();
    const first = await watch(target, { size: { width: 1000, height: 700 } });
    const second = await watch(target, { size: { width: 1400, height: 900 } });
    await until(() => pageSize(target), same([1400, 900, 2]));
    await first.viewer.input({ type: "resize", width: 900, height: 600 });
    await until(() => pageSize(target), same([1280, 853, 2]));
    await second.viewer.input({ type: "takeControl" });
    await second.viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await until(() => pageSize(target), same([390, 844, 2]));
    await second.viewer.input({ type: "viewport", setting: { mode: "fill" } });
    await until(() => pageSize(target), same([1280, 853, 2]));
    await second.viewer.input({ type: "releaseControl" });
    await first.viewer.close();
    await second.viewer.close();
  }, hostTimeout(90_000));

  it("lays a tab that opens later out at a narrow panel's desktop page taller than the screen too, and leaves it so when the bot comes back", async () => {
    const target = await opened();
    const { viewer } = await watch(target, { size: { width: 400, height: 700 } });
    await until(() => pageSize(target), same([1280, 2240, 2]));
    const windowWidth = await real.peek<number>(target, "outerWidth");
    expect(await real.peek<number>(target, "outerHeight")).toBeLessThanOrEqual(SCREEN.height);
    expect((await real.call(target, "agent_browser_tabs", { action: "new", url: page })).isError).toBeUndefined();
    await until(() => pageSize(target), same([1280, 2240, 2]));
    expect((await real.call(target, "agent_browser_tabs", { action: "switch", tab: "t1" })).isError).toBeUndefined();
    expect(await pageSize(target)).toEqual([1280, 2240, 2]);
    expect(await real.peek<number>(target, "outerWidth")).toBe(windowWidth);
    await viewer.close();
  }, hostTimeout(90_000));

  it("sends no more frames until the viewer acknowledges the ones it has", async () => {
    const target = await opened();
    const unacked = await watch(target, { size: { width: 1280, height: 800 } }, { ack: false });
    await until(() => unacked.frames.length, (count) => count > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const stalled = unacked.frames.filter((frame) => !frame.still).length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(unacked.frames.filter((frame) => !frame.still)).toHaveLength(stalled);
    expect(stalled).toBeLessThanOrEqual(3);
    await unacked.viewer.close();
    const acked = await watch(target, { size: { width: 1280, height: 800 } });
    await until(() => acked.frames.filter((frame) => !frame.still).length, (count) => count > stalled + 3, 20_000);
    await acked.viewer.close();
  }, hostTimeout(90_000));

  it("clicks an element where it is once the pointer people watch got there, after the page moved it", async () => {
    state = "still";
    const target = await opened(swap);
    const ref = /button "A" \[ref=(e\d+)\]/u.exec(real.text(await real.call(target, "agent_browser_snapshot")))![1]!;
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 1280 }, (output) => {
      if (output.type === "frame") output.ack();
      else if (output.type === "pointer" && output.phase === "move") state = "swap";
    });
    expect(real.text(await real.call(target, "agent_browser_click", { ref }))).toContain(`Clicked ${ref}.`);
    expect(await until(() => real.peek<string | undefined>(target, "document.body.dataset.clicked"), (value) => value !== undefined)).toMatch(/^a:/u);
    await viewer.close();
    state = "still";
  }, hostTimeout(90_000));

  it("resizes the page for a watching panel only once the bot's click is done, so the click lands where it aimed", async () => {
    state = "still";
    const target = await opened(swap);
    const ref = /button "A" \[ref=(e\d+)\]/u.exec(real.text(await real.call(target, "agent_browser_snapshot")))![1]!;
    let resized: Promise<void> | null = null;
    const viewer: Viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 2560, maxHeight: 1600, size: { width: 1280, height: 800 } }, (output) => {
      if (output.type === "frame") output.ack();
      else if (output.type === "pointer" && output.phase === "move") resized ??= viewer.input({ type: "resize", width: 400, height: 750 });
    });
    await until(() => pageSize(target), same([1280, 800, 2]));
    expect(real.text(await real.call(target, "agent_browser_click", { ref }))).toContain(`Clicked ${ref}.`);
    expect(resized).not.toBeNull();
    await resized;
    expect(await until(() => real.peek<string | undefined>(target, "document.body.dataset.clicked"), (value) => value !== undefined)).toBe("a:1280x800");
    await until(() => pageSize(target), same([1280, 2400, 2]));
    await viewer.close();
  }, hostTimeout(90_000));

  it("lets the bot see, click, type and scroll a narrow panel's tall page as it is laid out, and the standard page once nobody watches", async () => {
    const target = await opened(fx.page("/tall", TALL));
    const { viewer } = await watch(target, { size: { width: 400, height: 750 } });
    await until(() => pageSize(target), same([1280, 2400, 2]));
    const picture = await real.call(target, "agent_browser_screenshot");
    // The viewport is 1280 CSS pixels wide less the scrollbar a platform with classic scrollbars draws.
    const note = /(\d+)x1488 pixels: the (\d+)x2400 CSS-pixel viewport drawn at 0\.62, so divide x and y read off it by 0\.62/u.exec(real.text(picture));
    expect(note, real.text(picture)).not.toBeNull();
    const [width, region] = [Number(note![1]), Number(note![2])];
    expect(width).toBe(Math.round(region * 0.62));
    expect(pngSize(Buffer.from(picture.content.find((part) => part.type === "image")!.data!, "base64"))).toEqual({ width, height: 1488 });
    // The Low button's middle, read off the picture at 434,1240, divided by the scale its answer gave.
    expect((await real.call(target, "agent_browser_click", { x: 434 / 0.62, y: 1240 / 0.62 })).isError).toBeUndefined();
    expect(await real.peek<string>(target, "document.title")).toBe("at 700,2000 on low of 1280x2400");
    const outside = await real.call(target, "agent_browser_click", { x: 700, y: 2500 });
    expect(outside.isError).toBe(true);
    expect(real.text(outside)).toContain("outside the page's viewport, which is 1280x2400 CSS pixels now");
    const ref = /textbox "Field" \[ref=(e\d+)\]/u.exec(real.text(await real.call(target, "agent_browser_snapshot")))![1]!;
    expect((await real.call(target, "agent_browser_type", { ref, text: "typed low" })).isError).toBeUndefined();
    expect(await real.peek<string>(target, "document.getElementById('field').value")).toBe("typed low");
    expect(real.text(await real.call(target, "agent_browser_scroll", { dy: 600 }))).toContain("Scrolled by 0,600.");
    // A platform may scroll smoothly, and by more or less than the wheel's pixels: aim where the page came to rest.
    let top = -1;
    await until(async () => { const before = top; top = await real.peek<number>(target, "Math.round(scrollY)"); return top > 0 && top === before; }, Boolean);
    expect((await real.call(target, "agent_browser_click", { x: 700, y: 2000 - top })).isError).toBeUndefined();
    expect(await real.peek<string>(target, "document.title")).toBe(`at 700,${2000 - top} on low of 1280x2400`);
    await viewer.close();
    await until(() => pageSize(target), same([1280, 800, 2]));
    expect(real.text(await real.call(target, "agent_browser_screenshot"))).toMatch(/\d+x800 pixels, one per CSS pixel of the viewport/u);
    expect(real.text(await real.call(target, "agent_browser_click", { x: 700, y: 2000 }))).toContain("which is 1280x800 CSS pixels now");
  }, hostTimeout(90_000));

  it("ends a scroll on a sharp frame at full size", async () => {
    const target = await opened();
    const { viewer, frames } = await watch(target, { size: { width: 1280, height: 800 }, maxWidth: 2560, maxHeight: 1600 });
    await until(() => frames.at(-1), (frame) => frame?.width === 2560);
    await viewer.input({ type: "takeControl" });
    const scrolling = Date.now();
    for (let step = 0; step < 12; step++) {
      await viewer.input({ type: "wheel", x: 400, y: 400, deltaX: 0, deltaY: 120 });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const scrolled = Date.now();
    const sharp = (frame: Seen) => frame.width === 2560 && frame.height === 1600;
    // With the spinner scrolled out of view the page may stop painting, so the scroll's last frame can come before any
    // fixed mark: once the stream has been quiet for two seconds, its last frame is the one the person keeps seeing.
    const last = await until(() => frames.at(-1), (frame) => frame !== undefined && frame.at > scrolling && ((frame.at > scrolled + 400 && sharp(frame)) || Date.now() - frame.at > 2_000));
    expect(last).toMatchObject({ width: 2560, height: 1600 });
    for (const frame of frames) expect([1280, 2560]).toContain(frame.width);
    expect(await real.peek<number>(target, "scrollY")).toBeGreaterThan(0);
    await viewer.input({ type: "releaseControl" });
    await viewer.close();
  }, hostTimeout(90_000));
});

suite("a bot's browser on a laptop's screen", () => {
  it("never makes its window larger than the screen it reports, and fills a panel too large for it in the panel's shape", async () => {
    const screen: ScreenSpec = { width: 1512, height: 982, deviceScaleFactor: 2 };
    const fits = (size: { width: number; height: number }) => fitPage(size, pageLimit(screen));
    const fx = await FixtureServer.start();
    const real = await startService({ screen });
    try {
      const target = { session: "screen-1", key: "bot:screen-1" };
      expect((await real.call(target, "agent_browser_open", { url: fx.page("/plain", "<!doctype html><title>plain</title><p>plain</p>") })).isError).toBeUndefined();
      type Geometry = { inner: [number, number]; outer: [number, number]; avail: [number, number] };
      const geometry = () => real.peek<Geometry>(target, "({ inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], avail: [screen.availWidth, screen.availHeight] })");
      const viewports: Array<{ width: number; height: number }> = [];
      // A tab with a taller bar than the limit allows for gets a shorter page, never a larger window.
      const showsWithin = async (size: { width: number; height: number }, told = true) => {
        const seen = await until(geometry, (value) => value.inner[0] === size.width && value.inner[1] <= size.height);
        expect(seen.outer[0]).toBeLessThanOrEqual(seen.avail[0]);
        expect(seen.outer[1]).toBeLessThanOrEqual(seen.avail[1]);
        if (told) await until(() => viewports.at(-1), (last) => last?.width === seen.inner[0] && last.height === seen.inner[1]);
      };
      await showsWithin(fits({ width: 1280, height: 800 }), false);
      const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 3200, maxHeight: 2000, size: { width: 1600, height: 1000 } }, (output) => {
        if (output.type === "frame") output.ack();
        else if (output.type === "viewport") viewports.push({ width: output.width, height: output.height });
      });
      await showsWithin(fits({ width: 1600, height: 1000 }));
      await viewer.input({ type: "resize", width: 3000, height: 1800 });
      await showsWithin(fits({ width: 3000, height: 1800 }));
      await viewer.input({ type: "takeControl" });
      await viewer.input({ type: "viewport", setting: { mode: "preset", preset: "tablet" } });
      await showsWithin({ width: 820, height: pageLimit(screen).height });
      await viewer.input({ type: "releaseControl" });
      await viewer.close();
    } finally {
      await real.close();
      await fx.close();
    }
  }, hostTimeout(180_000));
});

suite("a phone's v1 live view on real Chrome", () => {
  it("sends the events and fields the agent-browser engine sent, step for step", async () => {
    const pages = await startV1Pages();
    const real = await startService({ screen: { width: 1512, height: 982, deviceScaleFactor: 2 } });
    const target = { session: "bot-golden", key: "bot:golden" };
    const live = new LiveV1({ service: real.service, target: () => target });
    try {
      // A loaded runner's Chrome can paint a step's picture after the usual settle; the step waits for it.
      const records = await runV1Session({
        open: (res) => live.open({ botId: "bot", session: target.session, owner: "local-owner", isCurrent: () => true, res }),
        action: (viewerId, body) => live.action({ viewerId, botId: "bot", owner: "local-owner", body }),
      }, pages.origin, { shown: (record) => v1StepShown(normalizeV1([record], pages.origin)[0]!) });
      expect(v1Differences(normalizeV1(records, pages.origin))).toEqual([]);
    } finally {
      live.closeAll();
      await real.close();
      await pages.close();
    }
  }, hostTimeout(180_000));
});
