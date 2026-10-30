// A phone's session on the v1 live view, as the iOS app drives it: watch, take control, navigate, tap, type, use tabs,
// go back and forward, scroll, hand back. The same steps run against the agent-browser engine (to record the golden)
// and against the new browser, and their events must agree field for field.
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";

/** The page the session taps and types into; the field sits at (20..320, 20..60) of a 1280-wide page. */
const PAGE_A = `<!doctype html><title>Page A</title><body style="margin:0;font:16px sans-serif"><input id="field" style="position:absolute;left:20px;top:20px;width:300px;height:40px"><p style="position:absolute;top:100px">page a</p><div style="height:3000px"></div></body>`;
const PAGE_B = `<!doctype html><title>Page B</title><body><p>page b</p></body>`;

export async function startV1Pages(): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(request.url?.startsWith("/b") ? PAGE_B : PAGE_A);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** Collects the server-sent events a live view writes. */
export class SseRecorder extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  writableLength = 0;
  readonly events: Array<{ type: string; data: Record<string, unknown> }> = [];
  writeHead() { this.headersSent = true; }
  flushHeaders() {}
  write(chunk: string) {
    const match = /^event: (\w+)\ndata: (.*)\n\n$/su.exec(chunk);
    if (match) {
      const event = { type: match[1]!, data: JSON.parse(match[2]!) as Record<string, unknown> };
      this.events.push(event);
      this.emit("event", event);
    }
    return true;
  }
  end() { this.writableEnded = true; this.emit("close"); }
  destroy() { this.destroyed = true; this.emit("close"); }
  get response(): ServerResponse { return this as unknown as ServerResponse; }
}

export interface LiveDriver {
  open(res: ServerResponse): Promise<void>;
  action(viewerId: string, body: Record<string, unknown>): Promise<unknown>;
}

export interface StepRecord {
  step: string;
  answer: unknown;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs every step, acking each frame as a phone does, and returns the events each step brought. Each step waits
 * `settleMs`, then while `shown` says its events are still incomplete, at most `maxSettleMs` more. */
export async function runV1Session(driver: LiveDriver, origin: string, { settleMs = 1_200, shown, maxSettleMs = 10_000 }: {
  settleMs?: number; shown?: (record: StepRecord) => boolean; maxSettleMs?: number;
} = {}): Promise<StepRecord[]> {
  const sse = new SseRecorder();
  let viewerId = "";
  sse.on("event", (event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === "ready") viewerId = String(event.data.viewerId);
    if (event.type === "frame" && viewerId) void driver.action(viewerId, { type: "ack", seq: event.data.seq }).catch(() => undefined);
  });
  const records: StepRecord[] = [];
  let mark = 0;
  const step = async (name: string, run: () => Promise<unknown>) => {
    const answer = await run().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const record = (): StepRecord => ({ step: name, answer, events: sse.events.slice(mark) });
    await sleep(settleMs);
    for (const until = Date.now() + maxSettleMs; shown && !shown(record()) && Date.now() < until;) await sleep(50);
    records.push(record());
    mark = sse.events.length;
  };
  const act = (body: Record<string, unknown>) => driver.action(viewerId, body);
  const mouse = (eventType: string, x: number, y: number, extra: Record<string, unknown> = {}) => act({ type: "input_mouse", eventType, x, y, button: eventType === "mouseMoved" ? "none" : "left", clickCount: eventType === "mouseMoved" ? 0 : 1, modifiers: 0, ...extra });
  await step("open", () => driver.open(sse.response));
  await step("take", () => act({ type: "take" }));
  await step("navigate", () => act({ type: "navigate", url: `${origin}/a` }));
  await step("tap", async () => {
    await mouse("mouseMoved", 100, 40);
    await mouse("mousePressed", 100, 40);
    return mouse("mouseReleased", 100, 40);
  });
  await step("type", () => act({ type: "input_keyboard", eventType: "char", text: "hi" }));
  await step("enter", async () => {
    await act({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
    return act({ type: "input_keyboard", eventType: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
  });
  await step("scroll", () => mouse("mouseWheel", 640, 400, { button: "none", clickCount: 0, deltaX: 0, deltaY: 400 }));
  await step("tab-new", () => act({ type: "tab-new", url: `${origin}/b` }));
  const tabs = () => [...sse.events].reverse().find((event) => event.type === "tabs")?.data.tabs as Array<{ tabId: string; active: boolean }> | undefined;
  await step("tab-select", () => act({ type: "tab-select", tabId: tabs()?.find((tab) => !tab.active)?.tabId ?? "t1" }));
  await step("tab-close", () => act({ type: "tab-close", tabId: tabs()?.find((tab) => !tab.active)?.tabId ?? "t2" }));
  await step("back", () => act({ type: "back" }));
  await step("forward", () => act({ type: "forward" }));
  await step("reload", () => act({ type: "reload" }));
  await step("release", () => act({ type: "release" }));
  sse.end();
  return records;
}

/** A value's field names and types, which is what the v1 contract holds an event to. */
export function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, shape(inner)]));
  return typeof value;
}

/** What a phone relies on from each step, without frame bytes, timestamps, ports or ids that differ between runs. */
export function normalizeV1(records: StepRecord[], origin: string): Array<Record<string, unknown>> {
  const path = (url: unknown) => (typeof url === "string" ? url.replace(origin, "<origin>") : url);
  return records.map(({ step, answer, events }) => {
    const shown = events.filter((event) => event.type !== "heartbeat");
    const last = (type: string) => [...shown].reverse().find((event) => event.type === type)?.data;
    const control = last("control");
    const tabs = last("tabs")?.tabs as Array<{ tabId: string; title: string; url: string; active: boolean }> | undefined;
    const url = last("url");
    const status = last("status");
    const frame = last("frame");
    const shapes = Object.fromEntries([...new Set(shown.map((event) => event.type))].sort().map((type) => [type, shape(shown.find((event) => event.type === type)!.data)]));
    return {
      step,
      answer: shape(answer),
      events: Object.keys(shapes),
      shapes,
      ...(control ? { control } : {}),
      ...(tabs ? { tabs: tabs.map((tab) => ({ title: tab.title, url: path(tab.url), active: tab.active })) } : {}),
      ...(url ? { url: path(url.url) } : {}),
      ...(status ? { connected: status.connected } : {}),
      ...(frame ? { frameFormat: frame.format } : {}),
    };
  });
}
