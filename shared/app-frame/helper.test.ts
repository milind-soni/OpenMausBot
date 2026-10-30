import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

import type { AppDocument } from "../app.ts";
import { createAppBridge, type AppBridge } from "./bridge.ts";
import { BOT_HTML_CSP, BOT_HTML_NETWORK } from "./csp.ts";
import { APP_HELPER_SOURCE } from "./helper.ts";

const DOC: AppDocument = {
  v: 1, messageId: "m1", rev: 0, srcdoc: "", csp: BOT_HTML_CSP,
  network: { connect: [...BOT_HTML_NETWORK.connect], resources: [...BOT_HTML_NETWORK.resources] },
  can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
};

type Listener = (event: { source: unknown; data: unknown }) => void;
const pages: Window[] = [];
afterEach(async () => { for (const page of pages.splice(0)) await page.happyDOM.close(); });

function boot(engaged = true) {
  const page = new Window();
  pages.push(page);
  const listeners = new Set<Listener>();
  let bridge: AppBridge;
  const parent = {
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      setTimeout(() => bridge.handleMessage({ source: frame, data: copy }), 0);
    },
  };
  const frame: Record<string, unknown> = {
    parent,
    addEventListener(type: string, listener: Listener) { if (type === "message") listeners.add(listener); },
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      setTimeout(() => { for (const listener of listeners) listener({ source: parent, data: copy }); }, 0);
    },
  };
  const seen = { messages: [] as string[], links: [] as string[], contexts: [] as unknown[], heights: [] as number[] };
  bridge = createAppBridge({
    doc: DOC,
    hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa", "not-a-variable": "x" } } },
    source: () => frame,
    hostVersion: "1",
    adapter: {
      post: (message) => (frame.postMessage as (data: unknown) => void)(message),
      callRpc: async () => ({}),
      sendMessage: async (text) => { seen.messages.push(text); },
      openLink: (url) => { seen.links.push(url); },
      setContext: (update) => { seen.contexts.push(update); },
      resize: (height) => { seen.heights.push(height); },
      engaged: () => engaged,
      teardownRequested: () => {},
      now: () => Date.now(),
    },
  });
  // The helper's free names, bound to this fake frame: it runs exactly as written.
  const run = new Function("window", "document", "ResizeObserver", "requestAnimationFrame", APP_HELPER_SOURCE);
  run(frame, page.document, undefined, (callback: () => void) => setTimeout(callback, 0));
  return { bridge, seen, frame, root: page.document.documentElement, mausbot: () => frame.mausbot as {
    send(text: string): Promise<void>; open(url: string): Promise<void>; setContext(text: string): Promise<void>; theme: string;
  } };
}

describe("the bot-page helper", () => {
  it("initializes, applies the theme and variables, and reports its size", async () => {
    const page = boot();
    await expect.poll(() => page.bridge.initialized).toBe(true);
    expect(page.mausbot().theme).toBe("dark");
    expect(page.root.getAttribute("data-theme")).toBe("dark");
    expect(page.root.style.getPropertyValue("--color-text-primary")).toBe("#fafafa");
    expect(page.root.style.getPropertyValue("not-a-variable")).toBe("");
    await expect.poll(() => page.seen.heights.length).toBeGreaterThan(0);
    page.bridge.contextChanged({ theme: "light" });
    await expect.poll(() => page.mausbot().theme).toBe("light");
    expect(page.root.style.colorScheme).toBe("light");
  });

  it("sends, opens and sets context through the bridge", async () => {
    const page = boot();
    await page.mausbot().send("Book the 3pm slot");
    expect(page.seen.messages).toEqual(["Book the 3pm slot"]);
    await page.mausbot().open("https://example.com/docs");
    expect(page.seen.links).toEqual(["https://example.com/docs"]);
    await page.mausbot().setContext("Looking at March");
    await expect.poll(() => page.seen.contexts.length).toBe(1);
    expect(page.seen.contexts[0]).toEqual({ content: [{ type: "text", text: "Looking at March" }] });
  });

  it("rejects when the host refuses, as it does without a click in the page", async () => {
    const page = boot(false);
    await expect(page.mausbot().send("hi")).rejects.toThrow(/click/);
    await expect(page.mausbot().open("https://example.com")).rejects.toThrow(/click/);
    expect(page.seen.messages).toEqual([]);
  });

  it("answers teardown, and its global cannot be replaced by the page", async () => {
    const page = boot();
    await expect.poll(() => page.bridge.initialized).toBe(true);
    const started = Date.now();
    await page.bridge.teardown();
    expect(Date.now() - started).toBeLessThan(900);
    const original = page.mausbot();
    expect(() => { "use strict"; (page.frame as { mausbot: unknown }).mausbot = {}; }).toThrow();
    expect(page.mausbot()).toBe(original);
  });
});
