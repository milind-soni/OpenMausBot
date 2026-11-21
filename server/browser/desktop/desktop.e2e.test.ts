// A bot's browser on a private display, end to end on real Chrome and a real Xvnc: a person's view through the desktop
// route sees the window, its clicks and keys reach the page only while the person holds the browser, and the bot's own
// clicks and typing still work on the same page once it is handed back. Runs where OMB_CDP_CHROME (or OMB_CDP_E2E=1) names
// a Chrome and Xvnc is installed; skipped elsewhere. OMB_DESKTOP_MEASURE=1 also prints memory and CPU against headless.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { hostTimeout } from "../../testing/host-timeout.ts";
import { FixtureServer } from "../cdp/testing/fixtures.ts";
import { CHROME } from "../cdp/testing/real-chrome.ts";
import { BROWSER_CONTROL_REFUSAL } from "../control.ts";
import type { BrowserTarget } from "../service.ts";
import { startService, until, type RealService } from "../testing/real-service.ts";
import { DESKTOP_SIZE, DisplaySupervisor, findXvnc } from "./displays.ts";
import { findBwrap } from "./policy.ts";
import { DesktopViews } from "./views.ts";

const XVNC = findXvnc();
const BWRAP = findBwrap();
const suite = CHROME && XVNC && BWRAP ? describe : describe.skip;
if (CHROME && (!XVNC || !BWRAP)) console.log("skipping the browser desktop suite: no Xvnc on PATH, or bubblewrap cannot run here");

const PAGE = `<!doctype html><title>desk</title><style>body{margin:0}</style>
<button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">B</button>
<input id="f" aria-label="Field" style="position:absolute;left:100px;top:250px;width:300px;height:40px">
<select id="s" aria-label="Choice" style="position:absolute;left:100px;top:350px;width:200px;height:30px"><option>one</option><option>two</option><option>three</option></select>
<input id="up" type="file" aria-label="Upload" style="position:absolute;left:100px;top:420px;width:300px;height:40px">`;

/** A minimal RFB 3.8 client over the desktop route: the handshake, then raw messages. */
class RfbClient {
  readonly #ws: WebSocket;
  #buffer = Buffer.alloc(0);
  #waiting: (() => void) | null = null;
  closed: number | null = null;
  width = 0;
  height = 0;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(data as Buffer)]);
      this.#waiting?.();
    });
    ws.on("close", (code) => { this.closed = code; this.#waiting?.(); });
  }

  /** Every client a case opened, closed after it whatever happened. */
  static readonly open = new Set<RfbClient>();

  static async connect(url: string): Promise<RfbClient> {
    const ws = new WebSocket(url);
    // Listening before the handshake ends: the display's first bytes can come in the same packet as the upgrade.
    const client = new RfbClient(ws);
    RfbClient.open.add(client);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    expect((await client.read(12)).toString("latin1")).toBe("RFB 003.008\n");
    client.send(Buffer.from("RFB 003.008\n", "latin1"));
    const count = (await client.read(1))[0]!;
    expect([...await client.read(count)]).toContain(1);
    client.send(Buffer.from([1]));
    expect((await client.read(4)).readUInt32BE(0)).toBe(0);
    client.send(Buffer.from([1]));
    const init = await client.read(24);
    client.width = init.readUInt16BE(0);
    client.height = init.readUInt16BE(2);
    await client.read(init.readUInt32BE(20));
    // Raw pixels, so an update is easy to recognise, and the display's own size changes (ExtendedDesktopSize).
    const encodings = Buffer.alloc(12);
    encodings[0] = 2;
    encodings.writeUInt16BE(2, 2);
    encodings.writeInt32BE(-308, 8);
    client.send(encodings);
    return client;
  }

  async read(bytes: number, timeoutMs = 15_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.#buffer.length < bytes) {
      if (this.closed !== null) throw new Error(`desktop view closed (${this.closed})`);
      if (Date.now() > deadline) throw new Error("desktop view sent too little");
      await new Promise<void>((resolve) => { this.#waiting = resolve; setTimeout(resolve, 100); });
    }
    const out = this.#buffer.subarray(0, bytes);
    this.#buffer = this.#buffer.subarray(bytes);
    return out;
  }

  /** Asks for a small corner of the screen and waits for the update that brings it. */
  async picture(): Promise<void> {
    this.#buffer = Buffer.alloc(0);
    this.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 16, 0, 16]));
    const head = await this.read(4);
    expect(head[0]).toBe(0);
  }

  send(bytes: Buffer): void {
    this.#ws.send(bytes);
  }

  click(x: number, y: number): void {
    const pointer = (mask: number) => { const message = Buffer.alloc(6); message[0] = 5; message[1] = mask; message.writeUInt16BE(x, 2); message.writeUInt16BE(y, 4); return message; };
    this.send(Buffer.concat([pointer(0), pointer(1), pointer(0)]));
  }

  type(text: string): void {
    this.keys([...text].map((char) => char.codePointAt(0)!));
  }

  /** Holds `modifiers` down while pressing `keysym`. */
  chord(modifiers: number[], keysym: number): void {
    const key = (down: boolean, sym: number) => { const message = Buffer.alloc(8); message[0] = 4; message[1] = down ? 1 : 0; message.writeUInt32BE(sym, 4); return message; };
    this.send(Buffer.concat([...modifiers.map((sym) => key(true, sym)), key(true, keysym), key(false, keysym), ...modifiers.reverse().map((sym) => key(false, sym))]));
  }

  /** Presses and lets go of each X keysym in turn. */
  keys(keysyms: number[]): void {
    const key = (down: boolean, keysym: number) => { const message = Buffer.alloc(8); message[0] = 4; message[1] = down ? 1 : 0; message.writeUInt32BE(keysym, 4); return message; };
    this.send(Buffer.concat(keysyms.flatMap((keysym) => [key(true, keysym), key(false, keysym)])));
  }

  /** Asks the display for a new size, as noVNC does for a view that resizes its session. */
  resize(width: number, height: number): void {
    const message = Buffer.alloc(8 + 16);
    message[0] = 251;
    message.writeUInt16BE(width, 2);
    message.writeUInt16BE(height, 4);
    message[6] = 1;
    message.writeUInt16BE(width, 16);
    message.writeUInt16BE(height, 18);
    this.send(message);
  }

  close(): void {
    RfbClient.open.delete(this);
    this.#ws.close();
  }
}

/** A process and everything it started, from /proc. */
function treeOf(root: number): Set<number> {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try { parents.set(Number(entry), Number(readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ")[1])); } catch {}
  }
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents) if (tree.has(parent) && !tree.has(pid)) { tree.add(pid); grew = true; }
  }
  return tree;
}

/** Memory of a process and everything it started, in MiB: proportional where the kernel reports it, else resident,
 * which counts shared pages once per process. */
function treeRss(root: number): number {
  let kib = 0;
  for (const pid of treeOf(root)) {
    let pss: string | undefined;
    try { pss = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1]; } catch {}
    try { kib += Number(pss ?? /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0); } catch {}
  }
  return Math.round(kib / 1024);
}

/** CPU seconds the processes and everything they started used, from /proc. */
function cpuSeconds(roots: number[]): number {
  let ticks = 0;
  for (const pid of roots.flatMap((root) => [...treeOf(root)])) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      ticks += Number(fields[11]) + Number(fields[12]);
    } catch {}
  }
  return ticks / 100;
}

/** The first byte of an X server's answer to a connection setup, as a client with `cookie` (or none): 1 is accepted, 0
 * refused. */
function xSetup(display: number, cookie: Buffer | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(`/tmp/.X11-unix/X${display}`);
    const name = cookie ? Buffer.from("MIT-MAGIC-COOKIE-1") : Buffer.alloc(0);
    const data = cookie ?? Buffer.alloc(0);
    const padded = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
    const head = Buffer.alloc(12);
    head[0] = 0x6c;
    head.writeUInt16LE(11, 2);
    head.writeUInt16LE(name.length, 6);
    head.writeUInt16LE(data.length, 8);
    socket.once("connect", () => socket.write(Buffer.concat([head, padded(name), padded(data)])));
    socket.once("data", (answer: Buffer) => { socket.destroy(); resolve(answer[0]!); });
    socket.once("error", reject);
  });
}

const BLOCKED = /This page is blocked|ERR_BLOCKED_BY_ADMINISTRATOR/;
const CONTROL = 0xffe3;
const SHIFT = 0xffe1;
const RETURN = 0xff0d;

/** Memory in use on the machine, in MiB. */
function usedMemory(): number {
  const info = readFileSync("/proc/meminfo", "utf8");
  const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
  return Math.round((field("MemTotal") - field("MemAvailable")) / 1024);
}

/** What a display's browser shows besides the page, for a failure message: its targets, and the page's focus and size. */
async function shownState(profile: { run: { browser: { connection: { root: { send<T>(method: string): Promise<T> } } } } | null; active(): { page: { evaluate(expression: string, options: { world: "page" }): Promise<unknown> } } | null }): Promise<string> {
  const targets = await profile.run?.browser.connection.root.send<{ targetInfos: Array<{ type: string; url: string; title: string }> }>("Target.getTargets").then((answer) => answer.targetInfos.map((info) => `${info.type} ${info.url} "${info.title}"`), (error: unknown) => [String(error)]);
  const page = await profile.active()?.page.evaluate("JSON.stringify({ focus: document.hasFocus(), visibility: document.visibilityState, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screenX, screenY] })", { world: "page" }).catch((error: unknown) => String(error));
  return JSON.stringify({ targets, page });
}

const xvncPid = (socket: string) => readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).find((pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(socket); } catch { return false; }
});

suite("a bot's browser on a private display", () => {
  let fx: FixtureServer;
  let real: RealService;
  let displays: DisplaySupervisor;
  let views: DesktopViews;
  let server: Server;
  let root: string;
  let page: string;
  const target: BrowserTarget = { session: "desk", key: "bot:desk" };
  const filesTarget: BrowserTarget = { session: "files", key: "bot:files" };
  /** What Chrome said each time it could not start on its display (it then starts headless): the first failure's whole
   * text, Chrome's own last lines included, is what a failing run reports. */
  const displayFailures: string[] = [];
  const startedOnDisplay = () => expect(displayFailures.join("\n\n") || "started on its display").toBe("started on its display");
  let workspace: string;
  const person = "alice";

  beforeAll(async () => {
    fx = await FixtureServer.start();
    page = fx.page("/desk", PAGE);
    root = mkdtempSync("/tmp/omb-desk-");
    displays = new DisplaySupervisor({ root, xvnc: XVNC, bwrap: BWRAP });
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "report.html"), "<!doctype html><title>report</title><p>the bot's own report</p>");
    real = await startService({
      display: (key) => displays.acquire(key, DESKTOP_SIZE, key === filesTarget.key ? [workspace] : []),
      displayFailed: (reason) => { displayFailures.push(reason); },
    });
    views = new DesktopViews({ desktop: (asked) => real.service.desktop(asked) });
    server = createServer();
    server.on("upgrade", (req, socket, head) => {
      const interactive = !(req.url ?? "").includes("interactive=false");
      views.open({ target, botId: "desk", owner: "session", person, canOperate: interactive, req, socket: socket as Socket, head, isCurrent: () => true });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }, hostTimeout(240_000));

  // A case that fails part-way never leaves its hold or its view to the next one.
  afterEach(async () => {
    for (const client of RfbClient.open) client.close();
    for (const profile of real?.service.profiles() ?? []) {
      const owner = profile.control.owner;
      if (owner !== null) await profile.control.release(owner, async () => true).catch(() => undefined);
    }
  });

  afterAll(async () => {
    views?.closeAll();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    await real?.close();
    await displays?.closeAll();
    rmSync(root, { recursive: true, force: true });
    await fx?.close();
  });

  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/desktop`;
  const display = () => real.service.profiles().find((candidate) => candidate.key === target.key)!.run!.opened.display!;
  const read = <T>(expression: string) => real.peek<T>(target, expression);
  /** Where the page's point (x, y) is on the display: the window fills it from its corner, its tab strip above the page. */
  const onScreen = async (x: number, y: number) => {
    const [left, top] = await read<[number, number]>("[screenX + outerWidth - innerWidth, screenY + outerHeight - innerHeight]");
    return { x: left + x, y: top + y };
  };

  it("shows a window that fills the display, and lets only the person holding the browser drive it", async () => {
    expect((await real.call(target, "agent_browser_open", { url: page })).isError).toBeUndefined();
    startedOnDisplay();
    const profile = real.service.profiles().find((candidate) => candidate.key === target.key)!;
    expect(profile.run?.opened.display?.size).toEqual(DESKTOP_SIZE);
    // With no window manager, X11 Chrome 156 keeps its window a pixel short of the size it was given.
    const [outerWidth, outerHeight] = await read<[number, number]>("[outerWidth, outerHeight]");
    expect(DESKTOP_SIZE.width - outerWidth).toBeLessThanOrEqual(1);
    expect(DESKTOP_SIZE.height - outerHeight).toBeLessThanOrEqual(1);

    const desk = await RfbClient.connect(url());
    expect([desk.width, desk.height]).toEqual([DESKTOP_SIZE.width, DESKTOP_SIZE.height]);
    await desk.picture();

    const button = await onScreen(200, 140);
    desk.click(button.x, button.y);
    await desk.picture();
    expect(await read<string | undefined>("document.body.dataset.clicks")).toBeUndefined();

    await profile.control.take(person);
    await expect(real.call(target, "agent_browser_click", { selector: "#b" })).rejects.toThrow(BROWSER_CONTROL_REFUSAL);
    expect(real.text(await real.call(target, "agent_browser_snapshot"))).toContain('button "B"');
    desk.click(button.x, button.y);
    expect(await until(() => read<string | undefined>("document.body.dataset.clicks"), (value) => value === "1").catch(async (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; what the display's browser showed: ${await shownState(profile)}`);
    })).toBe("1");
    const field = await onScreen(250, 270);
    desk.click(field.x, field.y);
    desk.type("hi");
    expect(await until(() => read<string>("document.getElementById('f').value"), (value) => value === "hi")).toBe("hi");
    // A <select> opens Chrome's own popup, a window of its own on the display: there Down only moves the highlight
    // (on a closed list it would choose at once), and Return chooses.
    const choice = await onScreen(200, 365);
    desk.click(choice.x, choice.y);
    await until(() => read<string | undefined>("document.activeElement?.id"), (id) => id === "s");
    await desk.picture();
    desk.keys([0xff54]);
    await desk.picture();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await read<string>("document.getElementById('s').value")).toBe("one");
    desk.keys([0xff0d]);
    expect(await until(() => read<string>("document.getElementById('s').value"), (value) => value === "two")).toBe("two");

    const watcher = await RfbClient.connect(`${url()}?interactive=false`);
    watcher.click(button.x, button.y);
    await watcher.picture();
    expect(await read<string>("document.body.dataset.clicks")).toBe("1");
    watcher.close();

    await profile.control.release(person, async () => true);
    desk.click(button.x, button.y);
    await desk.picture();
    expect(await read<string>("document.body.dataset.clicks")).toBe("1");

    expect((await real.call(target, "agent_browser_click", { selector: "#b" })).isError).toBeUndefined();
    expect(await read<string>("document.body.dataset.clicks")).toBe("2");
    expect((await real.call(target, "agent_browser_fill", { selector: "#f", text: "bot" })).isError).toBeUndefined();
    expect(await read<string>("document.getElementById('f').value")).toBe("bot");
    desk.close();
  }, hostTimeout(120_000));

  it("lets the person's view size the display as the picture view sizes the page, the window follow it, and gives it back on hand-back", async () => {
    expect((await real.call(target, "agent_browser_open", { url: page })).isError).toBeUndefined();
    startedOnDisplay();
    const profile = real.service.profiles().find((candidate) => candidate.key === target.key)!;
    await profile.control.take(person);
    const desk = await RfbClient.connect(url());
    try {
      desk.resize(1600, 900);
      expect(await until(() => read<[number, number]>("[outerWidth, outerHeight]"), ([width, height]) => width >= 1599 && height >= 899, 10_000)).toEqual([expect.any(Number), expect.any(Number)]);
      desk.resize(400, 750);
      expect(await until(() => read<[number, number]>("[screen.width, screen.height]"), ([width, height]) => width === 1280 && height === 2400, 10_000)).toEqual([1280, 2400]);
    } finally {
      await profile.control.release(person, async () => true);
      desk.close();
    }
    const [width, height, outerWidth, outerHeight] = await until(() => read<[number, number, number, number]>("[screen.width, screen.height, outerWidth, outerHeight]"), ([screenWidth, screenHeight, outer]) => screenWidth === DESKTOP_SIZE.width && screenHeight === DESKTOP_SIZE.height && outer >= DESKTOP_SIZE.width - 1, 10_000);
    expect([width, height]).toEqual([DESKTOP_SIZE.width, DESKTOP_SIZE.height]);
    expect(DESKTOP_SIZE.width - outerWidth).toBeLessThanOrEqual(1);
    expect(DESKTOP_SIZE.height - outerHeight).toBeLessThanOrEqual(1);
  }, hostTimeout(120_000));

  it("keeps the display its browser's own: a private RFB socket, and X clients need the display's cookie", async () => {
    const display = real.service.profiles().find((candidate) => candidate.key === target.key)!.run!.opened.display!;
    expect(statSync(display.socket).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(display.socket)).mode & 0o777).toBe(0o700);
    const cookie = readFileSync(display.env.XAUTHORITY).subarray(-16);
    expect(await xSetup(display.number, null)).toBe(0);
    expect(await xSetup(display.number, Buffer.alloc(16, 7))).toBe(0);
    expect(await xSetup(display.number, cookie)).toBe(1);
  }, hostTimeout(60_000));

  it("leaves every Chrome not on a display without the lock-down, and lets a display's Chrome open only its own files", async () => {
    const shown = async (service: RealService, at: BrowserTarget, url: string) => {
      const tab = service.service.profiles().find((candidate) => candidate.key === at.key)!.active()!;
      const answer = await tab.page.session.send<{ errorText?: string }>("Page.navigate", { url });
      if (answer.errorText) return answer.errorText;
      return until(async () => {
        const text = await tab.page.evaluate("document.documentElement.innerText", { world: "page" }).catch(() => "");
        return typeof text === "string" ? text : "";
      }, (text) => text.length > 0, 10_000);
    };
    // The bot's tools open http(s), about:blank and data: only, here as everywhere.
    const refused = real.text(await real.call(filesTarget, "agent_browser_open", { url: `file://${workspace}/report.html` }));
    expect(refused).toMatch(/Only http\(s\), about:blank and data: addresses open here/);
    expect((await real.call(filesTarget, "agent_browser_open", { url: page })).isError).toBeUndefined();
    startedOnDisplay();
    expect(await shown(real, filesTarget, `file://${workspace}/report.html`)).toContain("the bot's own report");
    expect(await shown(real, filesTarget, "file:///etc/hostname")).toMatch(/ERR_BLOCKED_BY_ADMINISTRATOR|This page is blocked/);
    const headless = await startService();
    try {
      const plain: BrowserTarget = { session: "plain", key: "bot:plain" };
      expect((await headless.call(plain, "agent_browser_open", { url: page })).isError).toBeUndefined();
      expect(await shown(headless, plain, `file://${workspace}/report.html`)).toContain("the bot's own report");
      expect(await shown(headless, plain, "file:///etc/hostname")).not.toMatch(/ERR_BLOCKED_BY_ADMINISTRATOR|This page is blocked/);
    } finally {
      await headless.close();
    }
  }, hostTimeout(120_000));

  it("keeps Chrome's own address bar and shortcuts away from files, Chrome's pages and DevTools", async () => {
    expect((await real.call(target, "agent_browser_open", { url: page })).isError).toBeUndefined();
    startedOnDisplay();
    const profile = real.service.profiles().find((candidate) => candidate.key === target.key)!;
    const browser = profile.run!.browser;
    await profile.control.take(person);
    const desk = await RfbClient.connect(url());
    try {
      const targets = async () => (await browser.connection.root.send<{ targetInfos: Array<{ type: string; url: string; browserContextId?: string }> }>("Target.getTargets")).targetInfos;
      const textOf = async (tab: NonNullable<ReturnType<typeof profile.active>>) => {
        const text = await tab.page.evaluate("document.documentElement.innerText", { world: "page" }).catch(() => "");
        return typeof text === "string" ? text : "";
      };
      for (const address of ["file:///etc/passwd", "chrome://settings", "chrome://extensions", "chrome://settings/manageProfile", "chrome://inspect", "devtools://devtools/bundled/inspector.html", `view-source:${page}`, "about:settings"]) {
        // Each address in a new tab of its own, typed into Chrome's own address bar; the new tab page itself is allowed.
        const before = profile.tabs.list().length;
        desk.chord([CONTROL], 0x74);
        const opened = await until(() => profile.active(), (tab) => tab !== null && profile.tabs.list().length === before + 1, 10_000);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(await textOf(opened!), `new tab before ${address}`).not.toMatch(BLOCKED);
        desk.type(address);
        desk.keys([RETURN]);
        const shown = await until(() => textOf(opened!), (text) => BLOCKED.test(text), 10_000).catch(async () => `${await textOf(opened!)} ${JSON.stringify((await targets()).map((info) => info.url))}`);
        expect(shown, address).toMatch(BLOCKED);
        desk.chord([CONTROL], 0x77);
        await until(() => profile.tabs.list().length, (count) => count === before, 10_000);
      }
      // A file input still asks the panel, never a file dialog on this computer.
      await profile.control.release(person, async () => true);
      expect((await real.call(target, "agent_browser_open", { url: page })).isError).toBeUndefined();
      await profile.control.take(person);
      const upload = await onScreen(250, 440);
      desk.click(upload.x, upload.y);
      const front = profile.active()!;
      await until(() => front.page.fileChoosers.open, (open) => open !== null, 10_000);
      await front.page.fileChoosers.answer([display().env.XAUTHORITY]);
      expect(await until(() => read<string | undefined>("document.getElementById('up').files[0]?.name"), (name) => name === "Xauthority")).toBe("Xauthority");

      // DevTools, an incognito window and a guest window stay shut from the keyboard.
      const pages = (await targets()).filter((info) => info.type === "page").length;
      desk.keys([0xffc9]);
      desk.chord([CONTROL, SHIFT], 0x49);
      desk.chord([CONTROL, SHIFT], 0x4a);
      desk.chord([CONTROL, SHIFT], 0x4e);
      await desk.picture();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await targets();
      expect(after.filter((info) => info.url.startsWith("devtools://"))).toEqual([]);
      expect(after.filter((info) => info.type === "page")).toHaveLength(pages);
      console.log(JSON.stringify({ viewportAfterDevToolsKeys: await read<[number, number]>("[innerWidth, innerHeight]") }));
    } finally {
      await profile.control.release(person, async () => true);
      desk.close();
    }
  }, hostTimeout(180_000));

  it.runIf(process.env.OMB_DESKTOP_MEASURE === "1")("spends this much CPU on a picture stream under the desktop view, and none without one", async () => {
    const animated = fx.page("/spin", `<!doctype html><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:300px;height:300px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div>`);
    expect((await real.call(target, "agent_browser_open", { url: animated })).isError).toBeUndefined();
    const profile = real.service.profiles().find((candidate) => candidate.key === target.key)!;
    const roots = [xvncPid(profile.run!.opened.display!.socket)!, profile.run!.opened.pid!];
    const desk = await RfbClient.connect(url());
    const busy = async () => {
      const before = cpuSeconds(roots);
      const end = Date.now() + 10_000;
      while (Date.now() < end) await desk.picture();
      return Math.round(((cpuSeconds(roots) - before) / 10) * 1000) / 10;
    };
    const watch = (frames: boolean) => real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 1280, maxHeight: 800, ...(frames ? {} : { frames: false }) }, (output) => { if (output.type === "frame") output.ack(); });
    const pictured = await watch(true);
    const withPictures = await busy();
    await pictured.close();
    const frameless = await watch(false);
    const withoutPictures = await busy();
    await frameless.close();
    desk.close();
    console.log(JSON.stringify({ animatedPageDesktopWatched: { cpuPercentWithPictureStream: withPictures, cpuPercentWithoutPictureStream: withoutPictures } }));
  }, hostTimeout(120_000));

  it.runIf(process.env.OMB_DESKTOP_MEASURE === "1")("costs this much memory and CPU against a headless browser", async () => {
    expect((await real.call(target, "agent_browser_open", { url: page })).isError).toBeUndefined();
    const profile = real.service.profiles().find((candidate) => candidate.key === target.key)!;
    const xvnc = xvncPid(profile.run!.opened.display!.socket)!;
    const chrome = profile.run!.opened.pid!;
    const busy = async (pids: number[]) => {
      const before = cpuSeconds(pids);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return Math.round(((cpuSeconds(pids) - before) / 10) * 1000) / 10;
    };
    const desk = await RfbClient.connect(url());
    const display = { xvncMiB: treeRss(xvnc), chromeMiB: treeRss(chrome), cpuPercentWatched: await busy([xvnc, chrome]) };
    desk.close();
    const idle = { cpuPercentIdle: await busy([xvnc, chrome]), usedMiB: usedMemory() };
    await real.service.closeAll();
    await displays.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const none = usedMemory();
    const headless = await startService();
    try {
      const plain: BrowserTarget = { session: "plain", key: "bot:plain" };
      await headless.call(plain, "agent_browser_open", { url: page });
      const run = headless.service.profiles().find((candidate) => candidate.key === plain.key)!.run!;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const plainUsed = usedMemory();
      console.log(JSON.stringify({
        display: { ...display, ...idle, addedMiB: idle.usedMiB - none },
        headless: { chromeMiB: treeRss(run.opened.pid!), cpuPercentIdle: await busy([run.opened.pid!]), addedMiB: plainUsed - none },
      }));
    } finally {
      await headless.close();
    }
  }, hostTimeout(180_000));
});
