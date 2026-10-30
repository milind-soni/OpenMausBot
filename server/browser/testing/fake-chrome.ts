// A pretend Chrome on the CDP wire, for the browser service's unit tests: pages are lists of elements, windows have a
// size, screencasts send small JPEGs, and every command sent is recorded. Real-Chrome suites cover the real thing.
import type { Backend, BackendCaps, OpenedBrowser, OpenRequest } from "../backends.ts";
import { CdpBrowser } from "../cdp/browser.ts";
import { fitPage } from "../chrome/flags.ts";
import type { Identity } from "../cdp/identity.ts";
import type { CdpTransport } from "../cdp/transport.ts";

export interface FakeElement {
  role: string;
  name: string;
  /** CSS selector this element answers to, such as #go. */
  selector?: string;
  value?: string;
  editable?: boolean;
  /** x, y, width, height in the viewport. */
  box?: [number, number, number, number];
  onClick?: (page: FakePage) => void;
}

export interface FakeDocument {
  title: string;
  text: string;
  elements: FakeElement[];
}

export interface FakePage {
  targetId: string;
  url: string;
  title: string;
  text: string;
  elements: FakeElement[];
  loaderId: string;
  history: string[];
  index: number;
  openerId?: string;
  focused: number | null;
  /** Emulation.setDeviceMetricsOverride's size, which the page then reports instead of its window's. */
  emulated?: { width: number; height: number } | null;
  /** A bar of this height over the page, as Chrome's first tab has. */
  bar?: number;
  screencasts: Map<string, { params: Record<string, unknown>; acked: number; sent: number }>;
}

export interface SentToFake {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | null;
}

/** 1x1 pictures with the right magic bytes; the service never decodes them. */
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const CHROME_HEIGHT = 143;
const MIN_WIDTH = 500;

export class FakeChrome implements CdpTransport {
  readonly sent: SentToFake[] = [];
  readonly pages = new Map<string, FakePage>();
  readonly window = { width: 1280, height: 720 + CHROME_HEIGHT };
  dpr = 2;
  /** Commands that never answer, to stand for a browser that hung. */
  hang: (method: string) => boolean = () => false;
  /** Milliseconds before a command answers, to stand for a slow page. */
  delay: (method: string) => number = () => 0;
  /** What the next navigations fail with, in order, such as net::ERR_ABORTED. */
  readonly navigationErrors: string[];
  readonly #documents: (url: string) => FakeDocument;
  readonly #messages = new Set<(message: string) => void>();
  readonly #closes = new Set<(reason: string) => void>();
  readonly #sessions = new Map<string, { targetId: string; viewer: boolean }>();
  #autoAttach = false;
  #next = 1;
  #closed: string | null = null;

  constructor({ documents, startUrls = ["about:blank"], navigationErrors = [] }: { documents?: (url: string) => FakeDocument; startUrls?: string[]; navigationErrors?: string[] } = {}) {
    this.#documents = documents ?? (() => ({ title: "", text: "", elements: [] }));
    this.navigationErrors = [...navigationErrors];
    for (const url of startUrls) this.#createPage(url);
  }

  get viewport(): { width: number; height: number } {
    return { width: this.window.width, height: this.window.height - CHROME_HEIGHT };
  }

  // CdpTransport.
  send(message: string): void {
    if (this.#closed !== null) return;
    const { id, method, params = {}, sessionId = null } = JSON.parse(message) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string | null };
    this.sent.push({ method, params, sessionId });
    if (this.hang(method)) return;
    let result: unknown;
    const restore = this.#clippedCapture(sessionId, method, params);
    try {
      result = sessionId === null ? this.#browser(method, params) : this.#page(sessionId, method, params);
    } catch (error) {
      queueMicrotask(() => this.#emit({ id, error: { message: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    const answer = () => {
      restore?.();
      this.#emit({ id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) });
    };
    const wait = this.delay(method);
    if (wait > 0) setTimeout(answer, wait);
    else queueMicrotask(answer);
  }

  onMessage(listener: (message: string) => void): void { this.#messages.add(listener); }
  onClose(listener: (reason: string) => void): void { if (this.#closed !== null) listener(this.#closed); else this.#closes.add(listener); }
  close(): void { this.exit("closed by the driver"); }

  exit(reason = "Chrome exited"): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    for (const listener of this.#closes) listener(reason);
  }

  #emit(message: Record<string, unknown>): void {
    if (this.#closed !== null) return;
    const text = JSON.stringify(message);
    for (const listener of this.#messages) listener(text);
  }

  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    queueMicrotask(() => this.#emit({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  #info(page: FakePage) {
    return { targetId: page.targetId, type: "page", url: page.url, title: page.title, attached: true, ...(page.openerId ? { openerId: page.openerId } : {}) };
  }

  #createPage(url: string, openerId?: string): FakePage {
    const targetId = `T${this.#next++}`;
    const page: FakePage = { targetId, url: "about:blank", title: "", text: "", elements: [], loaderId: `L${this.#next++}`, history: ["about:blank"], index: 0, focused: null, screencasts: new Map(), ...(openerId ? { openerId } : {}) };
    this.pages.set(targetId, page);
    if (url !== "about:blank") this.#load(page, url, true);
    return page;
  }

  #attach(page: FakePage, viewer: boolean): string {
    const sessionId = `${viewer ? "V" : "S"}${this.#next++}-${page.targetId}`;
    this.#sessions.set(sessionId, { targetId: page.targetId, viewer });
    this.event("Target.attachedToTarget", { sessionId, targetInfo: this.#info(page), waitingForDebugger: !viewer });
    return sessionId;
  }

  #mainSession(page: FakePage): string | undefined {
    return [...this.#sessions].find(([, entry]) => entry.targetId === page.targetId && !entry.viewer)?.[0];
  }

  /** Loads a document; `quiet` commits it before any session could hear of it, as a restored tab does. */
  #load(page: FakePage, url: string, quiet = false, push = true): void {
    const document = this.#documents(url);
    page.url = url;
    page.title = document.title || url.replace(/^https?:\/\//u, "");
    page.text = document.text;
    page.elements = document.elements;
    page.loaderId = `L${this.#next++}`;
    page.focused = null;
    if (push) {
      page.history = [...page.history.slice(0, page.index + 1), url];
      page.index = page.history.length - 1;
    }
    const session = this.#mainSession(page);
    if (quiet || !session) return;
    this.event("Page.frameNavigated", { frame: { id: page.targetId, url, loaderId: page.loaderId } }, session);
    for (const name of ["init", "DOMContentLoaded", "load"]) this.event("Page.lifecycleEvent", { frameId: page.targetId, loaderId: page.loaderId, name }, session);
    this.event("Page.loadEventFired", {}, session);
    this.event("Target.targetInfoChanged", { targetInfo: this.#info(page) });
  }

  /** A page opening another tab, as window.open or a target=_blank link does. */
  popup(opener: FakePage, url: string): FakePage {
    const page = this.#createPage(url, opener.targetId);
    if (this.#autoAttach) this.#attach(page, false);
    return page;
  }

  #browser(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "Target.setAutoAttach":
        this.#autoAttach = true;
        for (const page of this.pages.values()) if (!this.#mainSession(page)) this.#attach(page, false);
        return {};
      case "Target.createTarget": {
        const page = this.#createPage(String(params.url ?? "about:blank"));
        if (this.#autoAttach) this.#attach(page, false);
        return { targetId: page.targetId };
      }
      case "Target.attachToTarget": {
        const page = this.pages.get(String(params.targetId));
        if (!page) throw new Error("No target with given id found");
        return { sessionId: this.#attach(page, !this.#autoAttach ? false : true) };
      }
      case "Target.detachFromTarget":
        this.#sessions.delete(String(params.sessionId));
        this.event("Target.detachedFromTarget", { sessionId: params.sessionId });
        return {};
      case "Target.closeTarget": {
        const page = this.pages.get(String(params.targetId));
        if (!page) throw new Error("No target with given id found");
        this.pages.delete(page.targetId);
        for (const [sessionId, entry] of this.#sessions) {
          if (entry.targetId !== page.targetId) continue;
          this.#sessions.delete(sessionId);
          this.event("Target.detachedFromTarget", { sessionId, targetId: page.targetId });
        }
        this.event("Target.targetDestroyed", { targetId: page.targetId });
        return { success: true };
      }
      case "Target.getTargets":
        return { targetInfos: [...this.pages.values()].map((page) => this.#info(page)) };
      case "Browser.getWindowForTarget":
        return { windowId: 1 };
      case "Browser.getWindowBounds":
        return { bounds: { left: 0, top: 0, width: this.window.width, height: this.window.height, windowState: "normal" } };
      case "Browser.setWindowBounds": {
        const bounds = params.bounds as { width?: number; height?: number };
        if (bounds.width) this.window.width = Math.max(MIN_WIDTH, Math.round(bounds.width));
        if (bounds.height) this.window.height = Math.round(bounds.height);
        return {};
      }
      case "Browser.close":
        setTimeout(() => this.exit("Chrome quit"), 5);
        return {};
      case "Browser.getVersion":
        return { product: "Chrome/153.0.8010.12", userAgent: "Mozilla/5.0 Chrome/153.0.0.0", protocolVersion: "1.3", revision: "@x" };
      default:
        return {};
    }
  }

  #elementAt(page: FakePage, x: number, y: number): number | null {
    for (let i = page.elements.length - 1; i >= 0; i--) {
      const box = page.elements[i]!.box;
      if (box && x >= box[0] && y >= box[1] && x <= box[0] + box[2] && y <= box[1] + box[3]) return i;
    }
    return null;
  }

  #evaluate(page: FakePage, expression: string): unknown {
    const viewport = page.emulated ?? { width: this.viewport.width, height: this.viewport.height - (page.bar ?? 0) };
    if (expression === "[innerWidth, innerHeight]") return [viewport.width, viewport.height];
    if (expression === "devicePixelRatio") return this.dpr;
    if (expression === "document.readyState") return "complete";
    if (expression === "document.title") return page.title;
    if (expression.startsWith("({ url: location.href")) return { url: page.url, title: page.title, text: page.text };
    if (expression.includes("document.body.innerText") && expression.includes(".slice(")) return page.text;
    if (expression.includes("__ombTakeCopy")) return "";
    if (expression.includes("requestAnimationFrame")) return 1;
    if (expression.startsWith("({ x: innerWidth / 2")) return { x: viewport.width / 2, y: viewport.height / 2 };
    if (expression.startsWith("[Math.round(scrollX)")) return [0, 600, 3000];
    if (expression.includes(".includes(")) return page.text.includes(JSON.parse(/includes\((".*")\)/u.exec(expression)?.[1] ?? "\"\"") as string);
    return undefined;
  }

  /** Chrome draws a clipped capture by changing the page's emulation, then restores what it found when it began (155). */
  #clippedCapture(sessionId: string | null, method: string, params: Record<string, unknown>): (() => void) | null {
    const entry = sessionId === null ? undefined : this.#sessions.get(sessionId);
    const page = entry ? this.pages.get(entry.targetId) : undefined;
    if (method !== "Page.captureScreenshot" || !params.clip || !page) return null;
    const found = page.emulated ?? null;
    return () => { page.emulated = found; };
  }

  #page(sessionId: string, method: string, params: Record<string, unknown>): unknown {
    const entry = this.#sessions.get(sessionId);
    const page = entry ? this.pages.get(entry.targetId) : undefined;
    if (!entry || !page) throw new Error("No session with given id");
    const viewport = this.viewport;
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: page.targetId, url: page.url, loaderId: page.loaderId } } };
      case "Emulation.setDeviceMetricsOverride":
        page.emulated = { width: Number(params.width), height: Number(params.height) };
        return {};
      case "Emulation.clearDeviceMetricsOverride":
        page.emulated = null;
        return {};
      case "Page.createIsolatedWorld":
        return { executionContextId: this.#next++ };
      case "Page.navigate": {
        const errorText = this.navigationErrors.shift();
        if (errorText) return { frameId: page.targetId, loaderId: `L${this.#next++}`, errorText };
        const url = String(params.url);
        setTimeout(() => this.#load(page, url), 1);
        return { frameId: page.targetId, loaderId: `L${this.#next}` };
      }
      case "Page.reload":
        setTimeout(() => this.#load(page, page.url, false, false), 1);
        return {};
      case "Page.getNavigationHistory":
        return { currentIndex: page.index, entries: page.history.map((url, id) => ({ id, url, title: url })) };
      case "Page.navigateToHistoryEntry":
        page.index = Number(params.entryId);
        setTimeout(() => this.#load(page, page.history[page.index]!, false, false), 1);
        return {};
      case "Page.getLayoutMetrics": {
        const view = { pageX: 0, pageY: 0, clientWidth: viewport.width, clientHeight: viewport.height, scale: 1 };
        return { cssLayoutViewport: view, cssVisualViewport: view, cssContentSize: { width: viewport.width, height: 3000 } };
      }
      case "Page.captureScreenshot":
        return { data: params.format === "jpeg" ? JPEG : PNG };
      case "Page.startScreencast": {
        const cast = { params, acked: 0, sent: 0 };
        page.screencasts.set(sessionId, cast);
        this.#frame(page, sessionId);
        return {};
      }
      case "Page.stopScreencast":
        page.screencasts.delete(sessionId);
        return {};
      case "Page.screencastFrameAck": {
        const cast = page.screencasts.get(sessionId);
        if (cast) cast.acked++;
        return {};
      }
      case "Runtime.evaluate":
        if (params.expression === "document") return { result: { type: "object", objectId: "document" } };
        return { result: { type: "object", value: this.#evaluate(page, String(params.expression)) } };
      case "Runtime.callFunctionOn": {
        const fn = String(params.functionDeclaration);
        const args = (params.arguments as Array<{ value?: unknown }> | undefined) ?? [];
        if (fn.includes("querySelectorAll(css)") || fn.includes("createTreeWalker")) {
          const wanted = String(args[0]?.value ?? "");
          const found = page.elements.map((element, i) => ({ element, i })).filter(({ element }) => (fn.includes("createTreeWalker") ? element.name.toLowerCase().includes(wanted.toLowerCase()) : element.selector === wanted));
          return found.length === 1 ? { result: { type: "object", objectId: `node-${found[0]!.i + 1}` } } : { result: { type: "number", value: found.length } };
        }
        return { result: { type: "object", value: this.#call(page, fn, String(params.objectId ?? ""), args) } };
      }
      case "DOM.getDocument":
        return { root: { backendNodeId: 1000 } };
      case "DOM.resolveNode":
        return { object: { objectId: `node-${String(params.backendNodeId)}` } };
      case "DOM.describeNode":
        return { node: { backendNodeId: Number(String(params.objectId ?? "").replace("node-", "")) || 1000, nodeName: "DIV" } };
      case "DOM.getContentQuads": {
        const box = page.elements[Number(params.backendNodeId) - 1]?.box;
        if (!box) throw new Error("Could not compute content quads.");
        const [x, y, w, h] = box;
        return { quads: [[x, y, x + w, y, x + w, y + h, x, y + h]] };
      }
      case "DOM.getNodeForLocation": {
        const index = this.#elementAt(page, Number(params.x), Number(params.y));
        if (index === null) throw new Error("No node found at given location");
        return { backendNodeId: index + 1, frameId: page.targetId };
      }
      case "DOM.focus":
        page.focused = Number(params.backendNodeId) - 1;
        return {};
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            { nodeId: "root", role: { value: "RootWebArea" }, childIds: page.elements.map((_, i) => `n${i + 1}`) },
            ...page.elements.map((element, i) => ({ nodeId: `n${i + 1}`, parentId: "root", role: { value: element.role }, name: { value: element.name }, ...(element.value !== undefined ? { value: { value: element.value } } : {}), backendDOMNodeId: i + 1 })),
          ],
        };
      case "Input.dispatchMouseEvent": {
        if (params.type === "mouseReleased") {
          const index = this.#elementAt(page, Number(params.x), Number(params.y));
          if (index !== null) page.elements[index]!.onClick?.(page);
        }
        return {};
      }
      case "Input.insertText": {
        const element = page.focused === null ? undefined : page.elements[page.focused];
        if (element?.editable) element.value = `${element.value ?? ""}${String(params.text)}`;
        return {};
      }
      case "Input.dispatchKeyEvent": {
        const element = page.focused === null ? undefined : page.elements[page.focused];
        if (element?.editable && params.type === "keyDown" && params.key === "Backspace") element.value = "";
        if (element?.editable && params.type === "keyDown" && typeof params.text === "string" && params.text.length === 1 && params.text !== "\r") element.value = `${element.value ?? ""}${params.text}`;
        return {};
      }
      default:
        return {};
    }
  }

  #call(page: FakePage, fn: string, objectId: string, args: Array<{ value?: unknown }>): unknown {
    const index = Number(objectId.replace("node-", "")) - 1;
    const element = page.elements[index];
    if (fn.includes("wantEnabled")) return { disabled: false, covering: null };
    if (fn.includes("nonText") && fn.includes("contenteditable")) return element?.editable ? { kind: "text" } : null;
    if (fn.includes("root.activeElement")) return page.focused === index;
    if (fn.includes("innerText ?? this.textContent")) return element ? element.value ?? element.name : "";
    if (fn.includes("getComputedStyle")) return args.map(() => [false, null]);
    return null;
  }

  #frame(page: FakePage, sessionId: string): void {
    const cast = page.screencasts.get(sessionId);
    if (!cast) return;
    cast.sent++;
    const viewport = this.viewport;
    this.event("Page.screencastFrame", { data: JPEG, sessionId: cast.sent, metadata: { deviceWidth: viewport.width, deviceHeight: viewport.height, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: Date.now() / 1000 } }, sessionId);
  }

  /** The page repaints: every screencast on it gets a frame. */
  paint(page: FakePage): void {
    for (const sessionId of page.screencasts.keys()) this.#frame(page, sessionId);
  }

  /** What was sent to sessions whose page is `page`. */
  sentTo(page: FakePage): SentToFake[] {
    return this.sent.filter((sent) => sent.sessionId?.endsWith(`-${page.targetId}`));
  }
}

export const FAKE_IDENTITY: Identity = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  userAgentMetadata: {
    brands: [{ brand: "Chromium", version: "153" }], fullVersionList: [{ brand: "Chromium", version: "153.0.8010.12" }], fullVersion: "153.0.8010.12",
    platform: "macOS", platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
  },
  product: "Chrome/153.0.8010.12",
};

const FAKE_CAPS: BackendCaps = { persistentProfile: true, window: false, egressGate: false, identityOverride: true, ownsAllTabs: true, downloads: "local", uploads: "path", botPasskeys: false };

/** Opens a FakeChrome per start; `chromes` keeps each one, newest last. With `pageLimit`, its screen fits only that page. */
export class FakeBackend implements Backend {
  readonly kind = "local" as const;
  readonly caps = FAKE_CAPS;
  readonly chromes: FakeChrome[] = [];
  readonly opened: OpenRequest[] = [];
  readonly #make: (request: OpenRequest) => FakeChrome;
  readonly #pageLimit: { width: number; height: number } | null;

  constructor(make: (request: OpenRequest) => FakeChrome = () => new FakeChrome(), { pageLimit = null }: { pageLimit?: { width: number; height: number } | null } = {}) {
    this.#make = make;
    this.#pageLimit = pageLimit;
  }

  get chrome(): FakeChrome {
    const chrome = this.chromes.at(-1);
    if (!chrome) throw new Error("No fake Chrome was started.");
    return chrome;
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    this.opened.push(request);
    const chrome = this.#make(request);
    const limit = this.#pageLimit;
    const viewport = fitPage(request.viewport, limit);
    chrome.window.width = Math.max(MIN_WIDTH, viewport.width);
    chrome.window.height = viewport.height + CHROME_HEIGHT;
    this.chromes.push(chrome);
    const screen = limit ? { width: limit.width, height: limit.height + CHROME_HEIGHT } : null;
    const browser = await CdpBrowser.connect(chrome, { identity: FAKE_IDENTITY, headless: true, downloadDir: null, permissions: true, platform: "darwin", maxPages: 8, viewport, screen, handleAuth: true });
    let exited!: () => void;
    const done = new Promise<void>((resolve) => { exited = resolve; });
    chrome.onClose(() => exited());
    return { browser, pageLimit: limit, pid: null, version: "153.0.8010.12", exited: done, close: async () => { await browser.close(); } };
  }
}
