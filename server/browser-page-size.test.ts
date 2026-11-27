import { describe, expect, it } from "vitest";

import { BROWSER_VIEWPORT, MAX_PAGE_PIXELS, PageSizes, streamedPage, type PageSize } from "./browser-page-size.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A browser lane with one bot call that runs until `finish`, and the sizes its page was given. */
function setup({ watched = true } = {}) {
  const applied: PageSize[] = [];
  const call = deferred();
  let lane: Promise<unknown> = Promise.resolve();
  const state = { watched };
  const sizes = new PageSizes({
    apply: async (_session, size) => { applied.push(size); },
    lane: (_session, work) => { const turn = lane.then(work); lane = turn.then(() => undefined, () => undefined); return turn; },
    watched: () => state.watched,
  });
  const botCall = () => { lane = lane.then(() => call.promise); };
  return { sizes, applied, state, botCall, finish: call.resolve };
}

describe("the page size of a watched agent-browser page", () => {
  it("is the standard page until a panel asks, then that panel's shape at a desktop's width, applied once the bot's call ends", async () => {
    const { sizes, applied, botCall, finish } = setup();
    expect(sizes.wanted("s")).toEqual(BROWSER_VIEWPORT);
    botCall();
    const resizing = sizes.resize("s", { width: 400, height: 750 });
    expect(sizes.wanted("s")).toEqual({ width: 1280, height: 2400 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applied).toEqual([]);
    finish();
    await resizing;
    expect(applied).toEqual([{ width: 1280, height: 2400 }]);
    expect(await sizes.beforeCall("s")).toBe(false);
  });

  it("applies only the newest of the sizes a drag asked for while the bot's call ran", async () => {
    const { sizes, applied, botCall, finish } = setup();
    botCall();
    const first = sizes.resize("s", { width: 400, height: 750 });
    const second = sizes.resize("s", { width: 420, height: 700 });
    const last = sizes.resize("s", { width: 1440, height: 819 });
    expect(second).toBe(first);
    finish();
    await Promise.all([first, last]);
    expect(applied).toEqual([{ width: 1440, height: 819 }]);
  });

  it("leaves an unwatched page to the bot's next call, which sizes it first, and sizes a new browser again", async () => {
    const { sizes, applied, state } = setup({ watched: false });
    await sizes.resize("s", { width: 400, height: 750 });
    expect(applied).toEqual([]);
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(applied).toEqual([{ width: 1280, height: 2400 }]);
    await sizes.resize("s", null);
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(applied.at(-1)).toEqual(BROWSER_VIEWPORT);
    sizes.forget("s");
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(applied).toHaveLength(3);
    state.watched = true;
    await sizes.resize("s", null, true);
    expect(applied).toHaveLength(4);
  });

  it("keeps a page whose frames the live stream sends whole within 1280x2560's pixels, in the panel's shape and a desktop wide", () => {
    expect(streamedPage({ width: 365, height: 686 })).toEqual({ width: 1280, height: 2406 });
    expect(streamedPage({ width: 1440, height: 819 })).toEqual({ width: 1440, height: 819 });
    expect(streamedPage({ width: 3840, height: 2160 })).toEqual({ width: 2413, height: 1357 });
    expect(streamedPage({ width: 1600, height: 3200 })).toEqual({ width: 1280, height: 2560 });
    for (const panel of [{ width: 3840, height: 2160 }, { width: 2000, height: 2000 }, { width: 100, height: 2160 }]) {
      const page = streamedPage(panel);
      expect(page.width * page.height).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
      expect(page.width).toBeGreaterThanOrEqual(1280);
    }
  });

  it("asks for a JPEG screenshot of a page larger than the standard one, unless the bot chose a format", () => {
    const { sizes } = setup({ watched: false });
    const screenshot = { name: "agent_browser_screenshot", arguments: { fullPage: true } };
    expect(sizes.callArguments("s", screenshot)).toBe(screenshot);
    void sizes.resize("s", { width: 400, height: 750 });
    expect(sizes.callArguments("s", screenshot)).toEqual({ name: "agent_browser_screenshot", arguments: { fullPage: true, format: "jpeg", quality: 80 } });
    const png = { name: "agent_browser_screenshot", arguments: { format: "png" } };
    expect(sizes.callArguments("s", png)).toBe(png);
    const click = { name: "agent_browser_click", arguments: { selector: "@e1" } };
    expect(sizes.callArguments("s", click)).toBe(click);
  });
});
