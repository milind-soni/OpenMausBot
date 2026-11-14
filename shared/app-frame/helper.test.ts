import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

import { ROOM_VIEW_ONLY, type AppDocument } from "../app.ts";
import { createAppBridge, type AppBridge } from "./bridge.ts";
import { BOT_HTML_CSP, BOT_HTML_NETWORK } from "./csp.ts";
import { ROOM_CAN } from "./document.ts";
import { APP_HELPER_SOURCE, APP_ROOM_HELPER_SOURCE, APP_SELECTION_METHOD } from "./helper.ts";

const DOC: AppDocument = {
  v: 1, messageId: "m1", rev: 0, srcdoc: "", csp: BOT_HTML_CSP,
  network: { connect: [...BOT_HTML_NETWORK.connect], resources: [...BOT_HTML_NETWORK.resources] },
  can: { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true },
};

type Listener = (event: { source: unknown; data: unknown }) => void;
const pages: Window[] = [];
afterEach(async () => { for (const page of pages.splice(0)) await page.happyDOM.close(); });

/** What the fake frame's layout answers: the page's flow when html and body are freed, at a frame of `height`, and the
 * elements under the frame's middle. "window" follows the frame; `freed` is an element's height in the freed layout. */
interface Scene {
  flow: (height: number) => number;
  under?: Array<{ position?: "absolute" | "fixed"; width: number | "window"; height: number | "window"; freed?: number }>;
}

function boot(engaged = true, options: { scene?: Scene; start?: number; loaded?: boolean; room?: boolean } = {}) {
  const room = options.room === true;
  const page = new Window();
  pages.push(page);
  const listeners = new Set<Listener>();
  const loads = new Set<() => void>();
  const observers = new Set<() => void>();
  let bridge: AppBridge;
  // Every hop between the page and its host is a task of this fake frame's, counted until it has run, so a test can wait
  // for the frame to go quiet instead of for a time: a timer's wait is about 16 ms on Windows, and a report takes three.
  let pending = 0;
  const task = (run: () => void) => {
    pending += 1;
    setTimeout(() => { try { run(); } finally { pending -= 1; } }, 0);
  };
  const parent = {
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      if ((copy as { method?: string }).method === APP_SELECTION_METHOD) seen.selections.push((copy as { params: unknown }).params);
      task(() => bridge.handleMessage({ source: frame, data: copy }));
    },
  };
  const positions = new Map<unknown, string>();
  const frame: Record<string, unknown> = {
    parent,
    innerWidth: 760,
    innerHeight: options.start ?? 520,
    addEventListener(type: string, listener: Listener) {
      if (type === "message") listeners.add(listener);
      if (type === "load") loads.add(listener as unknown as () => void);
    },
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      task(() => { for (const listener of listeners) listener({ source: parent, data: copy }); });
    },
    getComputedStyle: (element: unknown) => ({ position: positions.get(element) ?? "static" }),
  };
  const document = page.document;
  const root = document.documentElement;
  Object.defineProperty(document, "readyState", { configurable: true, get: () => (options.loaded === false ? "loading" : "complete") });
  const scene = options.scene;
  if (scene) {
    const freed = () => root.style.getPropertyValue("height") === "max-content";
    const size = (value: number | "window", window: number) => (value === "window" ? window : value);
    const rect = (width: number, height: number) => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} }) as DOMRect;
    root.getBoundingClientRect = () => rect(frame.innerWidth as number, freed() ? scene.flow(frame.innerHeight as number) : frame.innerHeight as number);
    const under = (scene.under ?? []).map((layer) => {
      const element = document.createElement("div");
      document.body.appendChild(element);
      if (layer.position) positions.set(element, layer.position);
      element.getBoundingClientRect = () => {
        const width = size(layer.width, frame.innerWidth as number);
        const height = size(layer.height, frame.innerHeight as number);
        return rect(width, freed() && layer.freed !== undefined ? layer.freed : height);
      };
      return element;
    });
    (document as unknown as { elementsFromPoint(): Element[] }).elementsFromPoint = () => [...under, document.body, root];
  }
  const seen = { messages: [] as string[], links: [] as string[], contexts: [] as unknown[], heights: [] as number[], selections: [] as unknown[] };
  bridge = createAppBridge({
    doc: room ? { ...DOC, can: { ...ROOM_CAN }, room: true } : DOC,
    hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa", "not-a-variable": "x" } } },
    source: () => frame,
    hostVersion: "1",
    adapter: {
      post: (message) => (frame.postMessage as (data: unknown) => void)(message),
      callRpc: async () => ({}),
      sendMessage: async (text) => { seen.messages.push(text); },
      openLink: (url) => { seen.links.push(url); },
      setContext: (update) => { seen.contexts.push(update); },
      resize: (height) => {
        seen.heights.push(height);
        frame.innerHeight = height;
        for (const observed of observers) task(observed);
      },
      engaged: () => engaged,
      teardownRequested: () => {},
      now: () => Date.now(),
    },
  });
  class FakeResizeObserver {
    constructor(callback: () => void) { observers.add(callback); }
    observe() {}
  }
  // The helper's free names, bound to this fake frame: it runs exactly as written.
  const run = new Function("window", "document", "ResizeObserver", "requestAnimationFrame", room ? APP_ROOM_HELPER_SOURCE : APP_HELPER_SOURCE);
  run(frame, document, scene ? FakeResizeObserver : undefined, (callback: () => void) => task(callback));
  return {
    bridge, seen, frame, root,
    load: () => { options.loaded = true; for (const listener of loads) listener(); },
    reflow: () => { for (const observed of observers) task(observed); },
    /** Resolves once no task of the frame's is waiting to run: what a reflow started has reached the host, or come to nothing. */
    quiet: async () => {
      for (const deadline = Date.now() + 5_000; pending > 0;) {
        if (Date.now() > deadline) throw new Error(`the frame still had ${pending} task(s) waiting after 5 s`);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    mausbot: () => frame.mausbot as {
      send(text: string): Promise<void>; open(url: string): Promise<void>; setContext(text: string): Promise<void>; theme: string; room: boolean;
    },
  };
}

/** The heights reported once the frame has stopped changing, or after 20 rounds of a frame that never does. */
async function settled(page: ReturnType<typeof boot>) {
  await expect.poll(() => page.seen.heights.length).toBeGreaterThan(0);
  let count = -1;
  for (let round = 0; round < 20 && count !== page.seen.heights.length; round++) {
    count = page.seen.heights.length;
    page.reflow();
    await page.quiet();
  }
  return page.seen.heights;
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

  it("in a room, says so, and its send and setContext resolve without asking the host; a page that asks anyway is refused", async () => {
    const page = boot(true, { room: true });
    expect(page.mausbot().room).toBe(true);
    await page.mausbot().send("Book the 3pm slot");
    await page.mausbot().setContext("Looking at March");
    await page.mausbot().open("https://example.com/docs");
    expect(page.seen.links).toEqual(["https://example.com/docs"]);
    const answers: unknown[] = [];
    (page.frame.addEventListener as (type: string, listener: Listener) => void)("message", (event) => {
      if ([7, 8].includes((event.data as { id?: unknown }).id as number)) answers.push(event.data);
    });
    const parent = page.frame.parent as { postMessage(data: unknown): void };
    parent.postMessage({ jsonrpc: "2.0", id: 7, method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Book it" }] } });
    parent.postMessage({ jsonrpc: "2.0", id: 8, method: "ui/update-model-context", params: { content: [{ type: "text", text: "March" }] } });
    await expect.poll(() => answers.length).toBe(2);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: -32000, message: ROOM_VIEW_ONLY } },
      { jsonrpc: "2.0", id: 8, error: { code: -32000, message: ROOM_VIEW_ONLY } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(page.seen.messages).toEqual([]);
    expect(page.seen.contexts).toEqual([]);
    expect(boot().mausbot().room).toBe(false);
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

describe("the text the person selects in a bot page", () => {
  const selectText = (page: ReturnType<typeof boot>, text: string) => {
    const document = page.root.ownerDocument;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    document.body.appendChild(paragraph);
    document.getSelection()!.selectAllChildren(paragraph);
    document.dispatchEvent(new document.defaultView!.Event("selectionchange"));
  };

  it("is reported once it settles, and reported gone once, so the host can offer to cite it", async () => {
    const page = boot();
    await expect.poll(() => page.bridge.initialized).toBe(true);
    selectText(page, "Total: 42");
    await expect.poll(() => page.seen.selections.length).toBe(1);
    expect(page.seen.selections[0]).toMatchObject({ text: "Total: 42", left: expect.any(Number), bottom: expect.any(Number) });
    const document = page.root.ownerDocument;
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new document.defaultView!.Event("selectionchange"));
    await expect.poll(() => page.seen.selections.length).toBe(2);
    expect(page.seen.selections[1]).toEqual({ text: "" });
    document.dispatchEvent(new document.defaultView!.Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(page.seen.selections).toHaveLength(2);
  });

  it("is never reported from a room's page", async () => {
    const page = boot(true, { room: true });
    await expect.poll(() => page.bridge.initialized).toBe(true);
    selectText(page, "Total: 42");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(page.seen.selections).toEqual([]);
  });
});

describe("the height a bot page reports", () => {
  const flow = (height: number) => () => height;

  it("is its content's for a page that flows, with or without a small layer over it", async () => {
    expect(await settled(boot(true, { scene: { flow: flow(296) } }))).toEqual([296]);
    expect(await settled(boot(true, { scene: { flow: flow(60), under: [{ position: "absolute", width: 240, height: 90 }] } }))).toEqual([60]);
  });

  it("is the frame's starting height for a page drawn by a layer the size of the window", async () => {
    for (const position of ["absolute", "fixed"] as const) {
      expect(await settled(boot(true, { scene: { flow: flow(0), under: [{ position, width: "window", height: "window" }] } }))).toEqual([520]);
    }
    expect(await settled(boot(true, { start: 400, scene: { flow: flow(30), under: [{ position: "absolute", width: "window", height: "window" }] } }))).toEqual([400]);
  });

  it("is the starting height for a map sized by percentages with nothing in its flow", async () => {
    const map = { width: "window", height: "window", freed: 0 } as const;
    expect(await settled(boot(true, { scene: { flow: flow(0), under: [map] } }))).toEqual([520]);
  });

  it("is the content's for an element stretched to the window around content of its own", async () => {
    const stretched = { width: "window", height: "window", freed: 80 } as const;
    expect(await settled(boot(true, { scene: { flow: flow(80), under: [stretched] } }))).toEqual([80]);
  });

  it("is the content's when the flow is taller than a small page, even over a window layer", async () => {
    expect(await settled(boot(true, { scene: { flow: flow(300), under: [{ position: "absolute", width: "window", height: "window" }] } }))).toEqual([300]);
  });

  it("leaves the starting height once the flow needs more", async () => {
    let content = 0;
    const page = boot(true, { scene: { flow: () => content, under: [{ position: "absolute", width: "window", height: "window" }] } });
    expect(await settled(page)).toEqual([520]);
    content = 300;
    page.reflow();
    expect(await settled(page)).toEqual([520]);
    content = 610;
    page.reflow();
    expect(await settled(page)).toEqual([520, 610]);
  });

  it("settles when the layer covers the window only once the frame is small", async () => {
    const toolbar = { position: "absolute", width: "window", height: 44 } as const;
    expect(await settled(boot(true, { scene: { flow: flow(0), under: [toolbar] } }))).toEqual([48, 520]);
  });

  it("settles when the flow is sized from the window", async () => {
    const page = boot(true, { scene: { flow: (height) => Math.round(height * 0.3), under: [{ position: "absolute", width: "window", height: "window" }] } });
    expect(await settled(page)).toEqual([156, 520]);
  });

  it("waits for the page to load", async () => {
    const page = boot(true, { loaded: false, scene: { flow: flow(0), under: [{ position: "absolute", width: "window", height: "window" }] } });
    await expect.poll(() => page.bridge.initialized).toBe(true);
    page.reflow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.seen.heights).toEqual([]);
    page.load();
    expect(await settled(page)).toEqual([520]);
  });
});
