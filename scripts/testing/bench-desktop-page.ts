// The browser half of scripts/bench-desktop.ts: a disposable headless Chrome driven over the DevTools protocol, and
// the probe each page loads first. The probe counts React commits and which components rendered in each (through
// the hook React calls on every commit), timer and animation-frame callbacks, server frames, long tasks and when the
// sidebar and the transcript first show.
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";

type Params = Record<string, unknown>;

class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: Params) => void; reject: (error: Error) => void; method: string }>();
  private listeners = new Map<string, Set<(params: Params, sessionId?: string) => void>>();
  private socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Params; error?: { message: string }; method?: string; params?: Params; sessionId?: string };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter?.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method ?? "") ?? []) listener(message.params ?? {}, message.sessionId);
    });
  }
  send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method: string, listener: (params: Params, sessionId?: string) => void): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
  }
  close(): void { this.socket.close(); }
}

export interface ProbeOptions {
  storage: Record<string, string>;
  /** A stand-in desktop bridge with only the rail's entry point, for loading the rail's page. */
  railBridge?: boolean;
}

/** Runs in the page before any of its scripts. Kept free of TypeScript-only syntax: it is sent as source. */
function probe(options: ProbeOptions): void {
  const bench = {
    marks: {} as Record<string, number>, commits: 0, commitMs: 0, probeMs: 0, renderedTotal: 0, maxRendered: 0,
    renders: {} as Record<string, number>, selfMs: {} as Record<string, number>, mounts: {} as Record<string, number>,
    timerFires: {} as Record<string, number>, liveIntervals: new Map<number, string>(),
    sse: { frames: 0, bytes: 0, kinds: {} as Record<string, { n: number; bytes: number }> },
    longTasks: [] as Array<[number, number]>,
    reset() {
      bench.commits = 0; bench.commitMs = 0; bench.probeMs = 0; bench.renderedTotal = 0; bench.maxRendered = 0;
      bench.renders = {}; bench.selfMs = {}; bench.mounts = {}; bench.timerFires = {}; bench.longTasks = [];
      bench.sse = { frames: 0, bytes: 0, kinds: {} };
    },
  };
  (window as unknown as { __bench: typeof bench }).__bench = bench;
  for (const [key, value] of Object.entries(options.storage)) { try { localStorage.setItem(key, value); } catch { /* storage is optional */ } }
  if (options.railBridge) (window as unknown as { ogb: unknown }).ogb = { rail: { expand() {}, onSkin() { return () => {}; } } };
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) bench.longTasks.push([Math.round(entry.startTime), Math.round(entry.duration)]); })
      .observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => { const entry = list.getEntries().at(-1); if (entry) bench.marks.lcp = entry.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* observers are best effort */ }

  const fire = (key: string) => { bench.timerFires[key] = (bench.timerFires[key] ?? 0) + 1; };
  const bucket = (ms: number) => ms <= 0 ? "0" : ms < 50 ? "<50ms" : ms < 1000 ? `${Math.round(ms / 50) * 50}ms` : `${Math.round(ms / 1000)}s`;
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const nativeFrame = window.requestAnimationFrame.bind(window);
  (window as unknown as { setTimeout: unknown }).setTimeout = (callback: unknown, ms?: number, ...args: unknown[]) => {
    if (typeof callback !== "function") return nativeTimeout(callback as never, ms, ...args);
    const key = `timeout:${bucket(Number(ms) || 0)}`;
    return nativeTimeout((...inner: unknown[]) => { fire(key); return (callback as (...a: unknown[]) => unknown)(...inner); }, ms, ...args);
  };
  (window as unknown as { setInterval: unknown }).setInterval = (callback: unknown, ms?: number, ...args: unknown[]) => {
    const key = `interval:${bucket(Number(ms) || 0)}`;
    const id = nativeInterval((...inner: unknown[]) => { fire(key); return (callback as (...a: unknown[]) => unknown)(...inner); }, ms, ...args);
    bench.liveIntervals.set(id, key);
    return id;
  };
  window.clearInterval = (id?: number) => { if (id !== undefined) bench.liveIntervals.delete(id); nativeClearInterval(id); };
  window.requestAnimationFrame = (callback: FrameRequestCallback) => nativeFrame((time) => { fire("raf"); callback(time); });

  const NativeSource = window.EventSource;
  if (NativeSource) {
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", (event) => {
          const started = performance.now();
          const data = String((event as MessageEvent).data);
          bench.sse.frames += 1;
          bench.sse.bytes += data.length;
          let kind = "?";
          try { kind = String(JSON.parse(data).kind ?? "?"); } catch { /* counted as ? */ }
          const entry = bench.sse.kinds[kind] ?? (bench.sse.kinds[kind] = { n: 0, bytes: 0 });
          entry.n += 1;
          entry.bytes += data.length;
          bench.probeMs += performance.now() - started;
        });
      }
    } as typeof EventSource;
  }

  interface Fiber { tag: number; type: { displayName?: string; name?: string; render?: { displayName?: string; name?: string } } | null; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; flags: number; actualDuration?: number }
  const COMPOSITE = new Set([0, 1, 11, 15]);
  const nameOf = (fiber: Fiber) => {
    const type = fiber.type;
    if (!type) return "?";
    if (fiber.tag === 11) return type.displayName ?? type.render?.displayName ?? type.render?.name ?? "ForwardRef";
    return type.displayName || type.name || "Anonymous";
  };
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {},
    inject(renderer: unknown) { const self = this as { renderers: Map<number, unknown> }; const id = self.renderers.size + 1; self.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const started = performance.now();
      bench.commits += 1;
      bench.commitMs += root.current.actualDuration ?? 0;
      let rendered = 0;
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const fiber = stack.pop()!;
        const previous = fiber.alternate;
        if (COMPOSITE.has(fiber.tag)) {
          const name = nameOf(fiber);
          const mounted = !previous;
          if (mounted || fiber.flags & 1) {
            const counts = mounted ? bench.mounts : bench.renders;
            counts[name] = (counts[name] ?? 0) + 1;
            rendered += 1;
            if (typeof fiber.actualDuration === "number") {
              let self = fiber.actualDuration;
              for (let child = fiber.child; child; child = child.sibling) self -= child.actualDuration ?? 0;
              bench.selfMs[name] = (bench.selfMs[name] ?? 0) + Math.max(0, self);
            }
          }
        }
        if (previous && fiber.child === previous.child) continue;
        for (let child = fiber.child; child; child = child.sibling) stack.push(child);
      }
      bench.renderedTotal += rendered;
      bench.maxRendered = Math.max(bench.maxRendered, rendered);
      bench.probeMs += performance.now() - started;
    },
  };

  const milestones: Array<[string, string]> = [
    ["sidebar", "[data-sidebar-bot-row], [data-sidebar-group-row]"],
    ["transcript", "[data-mid]"],
  ];
  const watcher = new MutationObserver(() => {
    for (const [name, selector] of milestones) {
      if (bench.marks[name] === undefined && document.querySelector(selector)) {
        bench.marks[name] = performance.now();
        nativeFrame(() => { bench.marks[`${name}Frame`] = performance.now(); });
      }
    }
    if (milestones.every(([name]) => bench.marks[name] !== undefined)) watcher.disconnect();
  });
  watcher.observe(document, { childList: true, subtree: true });
}

export const probeSource = (options: ProbeOptions) => `(${probe.toString()})(${JSON.stringify(options)});`;

/** Finds the transcript's scrolling element, keeps it for later reads, and reports where it is and what it holds. */
export const TRANSCRIPT_BOX = `(() => {
  let el = document.querySelector("[data-mid]");
  while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (!el) return null;
  window.__benchScroller = el;
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, rows: document.querySelectorAll("[data-mid]").length,
    nodes: document.getElementsByTagName("*").length, top: el.scrollTop, height: el.scrollHeight };
})()`;
/** Records the time between animation frames until FRAMES_STOP runs. */
export const FRAMES_START = `(() => {
  const b = window.__bench;
  b.frames = []; b.recording = true; b.longTasksAtStart = b.longTasks.length;
  let last = performance.now();
  const step = () => { const now = performance.now(); b.frames.push(now - last); last = now; if (b.recording) requestAnimationFrame(step); };
  requestAnimationFrame(step);
})()`;
export const FRAMES_STOP = `(() => {
  const b = window.__bench;
  b.recording = false;
  const el = window.__benchScroller;
  return { frames: b.frames.slice(1), longTasks: b.longTasks.slice(b.longTasksAtStart), rows: document.querySelectorAll("[data-mid]").length,
    nodes: document.getElementsByTagName("*").length, top: el ? el.scrollTop : null, height: el ? el.scrollHeight : null };
})()`;
/** Clicks a sidebar row and resolves, in the page, on the first frame after \`ready\` holds: the switch as a person sees it. */
export const switchExpression = (botId: string, ready: string) => `new Promise((resolve) => {
  const row = document.querySelector('[data-sidebar-bot-row="${botId}"]');
  if (!row) { resolve({ clicked: false }); return; }
  const started = performance.now();
  row.click();
  const check = () => {
    if (${ready}) requestAnimationFrame(() => resolve({ clicked: true, ms: Math.round(performance.now() - started) }));
    else if (performance.now() - started > 30000) resolve({ clicked: true, timedOut: true });
    else setTimeout(check, 0);
  };
  check();
})`;

export class Page {
  private cdp: Cdp;
  readonly sessionId: string;
  readonly targetId: string;
  constructor(cdp: Cdp, sessionId: string, targetId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }
  send(method: string, params: Params = {}): Promise<Params> { return this.cdp.send(method, params, this.sessionId); }
  async evaluate<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (result.exceptionDetails) throw new Error(`page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value as T;
  }
  async metrics(): Promise<Record<string, number>> {
    const { metrics } = await this.send("Performance.getMetrics") as { metrics: Array<{ name: string; value: number }> };
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
  }
  async waitFor(expression: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`, false).catch(() => false)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
  async close(): Promise<void> { await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {}); }
}

export interface Chrome {
  pid: number;
  newPage(options: ProbeOptions, width?: number, height?: number): Promise<Page>;
  /** CPU seconds per Chrome process type (browser, renderer, GPU, utility), from Chrome itself. */
  cpu(): Promise<Record<string, number>>;
  /** Resident memory of each renderer process, in MB. */
  rendererRssMb(): Promise<number[]>;
  close(): Promise<void>;
}

const CHROME_FLAGS = [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--mute-audio", "--use-mock-keychain", "--password-store=basic", "--disable-extensions",
  "--enable-precise-memory-info",
];

export async function launchChrome(executable: string): Promise<Chrome> {
  const profile = mkdtempSync(join(tmpdir(), "openmausbot-bench-chrome-"));
  const child: ChildProcess = spawn(executable, [...CHROME_FLAGS, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (!existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill("SIGKILL");
      await removeTempDir(profile);
      throw new Error("Chrome did not open its DevTools port");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", () => reject(new Error("Chrome's DevTools socket did not open"))); });
  const cdp = new Cdp(socket);
  const processes = async () => ((await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: Array<{ type: string; id: number; cpuTime: number }> }).processInfo;
  return {
    pid: child.pid!,
    async newPage(options, width = 1440, height = 900) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", width, height, newWindow: true }) as { targetId: string };
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
      const page = new Page(cdp, sessionId, targetId);
      await page.send("Page.enable");
      await page.send("Performance.enable", { timeDomain: "threadTicks" });
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: probeSource(options) });
      return page;
    },
    async cpu() {
      const totals: Record<string, number> = {};
      for (const entry of await processes()) totals[entry.type] = (totals[entry.type] ?? 0) + entry.cpuTime;
      return totals;
    },
    async rendererRssMb() {
      const ids = (await processes()).filter((entry) => entry.type === "renderer").map((entry) => entry.id);
      if (!ids.length) return [];
      const out = execFileSync("ps", ["-o", "rss=", "-p", ids.join(",")], { encoding: "utf8" });
      return out.trim().split("\n").map((line) => Math.round(Number(line.trim()) / 1024));
    },
    async close() {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(profile);
    },
  };
}
