#!/usr/bin/env -S node --experimental-strip-types
// Measures the browser panel's v2 stream on a real Chrome, as the panel uses it: one WebSocket to the stream route,
// sized like a panel, each frame acknowledged on arrival. It reports the frame rate while a page animates, input to
// photon for a key and a click on a still page (send to the first frame that shows it), frame sizes while scrolling
// and after, the bytes a viewer receives and the CPU it costs. Pages come from a loopback server; nothing else is
// visited.
//   node --experimental-strip-types scripts/bench-browser-stream.ts [--chrome PATH] [--width 1600] [--height 1000] [--rounds 30]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    width: { type: "string", default: "1600" },
    height: { type: "string", default: "1000" },
    rounds: { type: "string", default: "30" },
    json: { type: "boolean", default: false },
  },
});
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = values.chrome ?? process.env.OMB_CDP_CHROME ?? (existsSync(MAC_CHROME) ? MAC_CHROME : "");
if (!chrome) throw new Error("Name a Chrome with --chrome PATH.");
// The test service reads which Chrome to run when it loads.
process.env.OMB_CDP_CHROME = chrome;

const { displayScreen } = await import("../server/browser/display.ts");
const { FixtureServer } = await import("../server/browser/cdp/testing/fixtures.ts");
const { startService, jpegSize } = await import("../server/browser/testing/real-service.ts");
const { StreamV2 } = await import("../server/browser/viewers/stream-v2.ts");
const { createBrowserViewerRoutes } = await import("../server/routes/browser-viewers.ts");
const { createUpgrades } = await import("../server/routes/upgrades.ts");
const { dispatchRoutes } = await import("../server/routes/table.ts");
const { json, readBody } = await import("../server/harness/http.ts");

const WIDTH = Number(values.width);
const HEIGHT = Number(values.height);
const ROUNDS = Number(values.rounds);
const STILL = `<!doctype html><title>still</title><style>html,body{margin:0;height:100%;background:#fff}</style>
<script>let dark=false;const flip=()=>{dark=!dark;document.body.style.background=dark?"#111":"#fff";};addEventListener("keydown",flip);addEventListener("mousedown",flip);</script>`;
const SPINNER = `<!doctype html><title>spinner</title><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:60px;height:60px;margin:40px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div>`;
const ANIMATED = `<!doctype html><title>animated</title><style>body{margin:0;background:linear-gradient(135deg,#fafafa,#d0d8e8)}@keyframes spin{to{transform:rotate(360deg)}}.s{width:180px;height:180px;margin:40px;display:inline-block;background:conic-gradient(#36c,#c63,#3c6,#36c);animation:spin 1.2s linear infinite}</style>${'<div class="s"></div>'.repeat(12)}<p style="font:16px system-ui;margin:40px">${"Streaming text stays readable at the screen's own scale. ".repeat(40)}</p>`;
const LONG = `<!doctype html><title>long</title><style>body{margin:40px;font:18px/1.6 system-ui}</style>${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i + 1}: ${"words to scroll past ".repeat(12)}</p>`).join("")}`;

const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? NaN;
};
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** CPU seconds a process and everything under it has used, from ps. */
function treeCpuSeconds(root: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/));
  const children = new Map<number, number[]>();
  const time = new Map<number, number>();
  for (const [pid, ppid, cpu] of rows) {
    const parts = (cpu ?? "0").split(":").map(Number);
    time.set(Number(pid), parts.reduce((sum, part) => sum * 60 + part, 0));
    children.set(Number(ppid), [...children.get(Number(ppid)) ?? [], Number(pid)]);
  }
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    total += time.get(pid) ?? 0;
    stack.push(...children.get(pid) ?? []);
  }
  return total;
}

const screen = await displayScreen("desktop");
const fx = await FixtureServer.start();
const real = await startService({ screen });
const target = { session: "bench", key: "bot:bench" };
const stream = new StreamV2({ service: real.service });
const upgrades = createUpgrades();
const route = createBrowserViewerRoutes({
  upgrades,
  dataDir: real.dataDir,
  viewers: {
    open: async () => {},
    action: async () => ({ ok: true }),
    stream: ({ session: _session, spec: _spec, ...request }) => { stream.open({ ...request, target }); return true; },
    fileChooserOffered: () => false,
    answerFileChooser: async () => false,
    download: () => undefined,
  },
  browser: async (botId) => ({ botId, session: target.session, spec: { command: "omb-cdp", args: [target.key], env: {} } }),
  authorize: async () => null,
  current: () => true,
  restartRefusal: () => null,
});
const loopback = { kind: "loopback", scopes: ["admin", "client"] } as never;
const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: loopback, json, readBody })) json(res, 404, { error: "no route" });
};
const server = createServer((req, res) => void handle(req, res));
upgrades.attach(server, handle);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Frame { at: number; width: number; height: number; bytes: number }
const frames: Frame[] = [];
const messages: Array<Record<string, unknown>> = [];
let waiter: ((frame: Frame) => void) | null = null;

async function open(url: string) {
  const result = await real.call(target, "agent_browser_open", { url });
  if (result.isError) throw new Error(real.text(result));
}

await open(fx.page("/still", STILL));
const opened = performance.now();
const socket = new WebSocket(`ws://${origin}/api/bots/bench/browser/stream?maxWidth=${WIDTH * screen.deviceScaleFactor}&maxHeight=${HEIGHT * screen.deviceScaleFactor}&width=${WIDTH}&height=${HEIGHT}`);
socket.binaryType = "arraybuffer";
socket.addEventListener("message", (event) => {
  if (typeof event.data === "string") { messages.push(JSON.parse(event.data) as Record<string, unknown>); return; }
  socket.send("{\"type\":\"ack\"}");
  const data = Buffer.from(event.data as ArrayBuffer);
  const frame = { at: performance.now(), ...jpegSize(data), bytes: data.byteLength };
  frames.push(frame);
  const wake = waiter;
  waiter = null;
  wake?.(frame);
});
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", () => reject(new Error("the stream did not open"))); });
const nextFrame = (timeoutMs = 2_000) => new Promise<Frame | null>((resolve) => {
  const timer = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
  waiter = (frame) => { clearTimeout(timer); resolve(frame); };
});
const first = await nextFrame(15_000);
const firstFrameMs = first ? first.at - opened : NaN;
const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
send({ type: "takeControl" });
for (let i = 0; i < 100 && !messages.some((message) => message.type === "control" && message.controller === "you"); i++) await sleep(50);
const pageSize = await real.peek<[number, number, number]>(target, "[innerWidth, innerHeight, devicePixelRatio]");

async function photon(act: () => void): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await sleep(450);
    const started = performance.now();
    const shown = nextFrame();
    act();
    const frame = await shown;
    if (frame) samples.push(frame.at - started);
  }
  return samples;
}
const keyLatency = await photon(() => {
  send({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 });
  send({ type: "key", action: "up", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 });
});
const clickLatency = await photon(() => {
  send({ type: "mouse", action: "down", x: WIDTH / 2, y: HEIGHT / 2, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  send({ type: "mouse", action: "up", x: WIDTH / 2, y: HEIGHT / 2, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
});

// A still page with a viewer costs nothing: no frames arrive.
await sleep(1_000);
const quietFrom = frames.length;
await sleep(3_000);
const quietFrames = frames.length - quietFrom;

const pid = real.service.profiles().find((profile) => profile.key === target.key)?.run?.opened.pid ?? null;
/** Frames, bytes and CPU while `path` animates for five seconds. */
async function animate(path: string, html: string) {
  send({ type: "navigate", url: fx.page(path, html) });
  await sleep(2_000);
  const from = frames.length;
  const cpuBefore = pid ? treeCpuSeconds(pid) : NaN;
  const nodeBefore = process.cpuUsage();
  const started = performance.now();
  await sleep(5_000);
  const elapsed = (performance.now() - started) / 1000;
  const chromeSeconds = (pid ? treeCpuSeconds(pid) : NaN) - cpuBefore;
  const node = process.cpuUsage(nodeBefore);
  const shown = frames.slice(from);
  return {
    fps: round(shown.length / elapsed),
    megabytesPerSecond: round(shown.reduce((sum, frame) => sum + frame.bytes, 0) / elapsed / 1e6, 2),
    chromeCores: round(chromeSeconds / elapsed, 2),
    serverCores: round((node.user + node.system) / 1e6 / elapsed, 2),
    frame: shown.at(-1) ? { width: shown.at(-1)!.width, height: shown.at(-1)!.height } : null,
  };
}
const spinner = await animate("/spinner", SPINNER);
const heavy = await animate("/animated", ANIMATED);

send({ type: "navigate", url: fx.page("/long", LONG) });
await sleep(2_000);
const scrollFrom = frames.length;
let lastWheel = 0;
for (let step = 0; step < 15; step++) {
  send({ type: "wheel", x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY: 120, modifiers: 0 });
  lastWheel = performance.now();
  await sleep(40);
}
await sleep(800);
const scrolled = frames.slice(scrollFrom);
const full = { width: pageSize[0] * pageSize[2], height: pageSize[1] * pageSize[2] };
const motionFrames = scrolled.filter((frame) => frame.width < full.width);
const settle = scrolled.find((frame) => frame.at > lastWheel && frame.width === full.width);

const result = {
  chrome,
  screen,
  panel: { width: WIDTH, height: HEIGHT },
  page: { width: pageSize[0], height: pageSize[1], devicePixelRatio: pageSize[2] },
  firstFrameMs: round(firstFrameMs),
  frame: heavy.frame,
  inputToPhotonMs: {
    key: { p50: round(percentile(keyLatency, 50)), p95: round(percentile(keyLatency, 95)), samples: keyLatency.length },
    click: { p50: round(percentile(clickLatency, 50)), p95: round(percentile(clickLatency, 95)), samples: clickLatency.length },
  },
  spinner,
  animated: heavy,
  stillPageFramesIn3s: quietFrames,
  scroll: {
    frames: scrolled.length,
    motionFrames: motionFrames.length,
    motionFrame: motionFrames[0] ? { width: motionFrames[0].width, height: motionFrames[0].height } : null,
    settledFrame: settle ? { width: settle.width, height: settle.height, msAfterLastWheel: round(settle.at - lastWheel) } : null,
  },
};
if (values.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`v2 stream on ${chrome}`);
  console.log(`screen ${screen.width}x${screen.height} @${screen.deviceScaleFactor}x; panel ${WIDTH}x${HEIGHT}; page ${result.page.width}x${result.page.height} @${result.page.devicePixelRatio}x; frames ${result.frame?.width}x${result.frame?.height}`);
  console.log(`first frame ${result.firstFrameMs} ms after the socket opened`);
  console.log(`input to photon: key p50 ${result.inputToPhotonMs.key.p50} ms, p95 ${result.inputToPhotonMs.key.p95} ms; click p50 ${result.inputToPhotonMs.click.p50} ms, p95 ${result.inputToPhotonMs.click.p95} ms (${ROUNDS} rounds each)`);
  console.log(`a spinner: ${spinner.fps} fps, ${spinner.megabytesPerSecond} MB/s, Chrome ${spinner.chromeCores} cores, server ${spinner.serverCores} cores`);
  console.log(`a page repainting all over: ${heavy.fps} fps, ${heavy.megabytesPerSecond} MB/s, Chrome ${heavy.chromeCores} cores, server ${heavy.serverCores} cores`);
  console.log(`still page with a viewer: ${quietFrames} frames in 3 s`);
  console.log(`scroll: ${result.scroll.motionFrames} of ${result.scroll.frames} frames at ${result.scroll.motionFrame?.width}x${result.scroll.motionFrame?.height}; sharp ${result.scroll.settledFrame?.width}x${result.scroll.settledFrame?.height} ${result.scroll.settledFrame?.msAfterLastWheel} ms after the last wheel`);
}
socket.close();
stream.closeAll();
upgrades.close();
await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
await real.close();
await fx.close();
