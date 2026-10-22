// The v2 stream on real Chrome, through its routes and a real WebSocket, as the desktop panel uses it: the page fills
// the panel at the screen's real scale and every drag ends sharp, a zoom follows new tabs, the person answers the
// page's file picker and dropdown lists, takes its downloads and its copied text.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { json, readBody } from "../../harness/http.ts";
import type { RequestAuth } from "../../request-auth.ts";
import { createBrowserViewerRoutes } from "../../routes/browser-viewers.ts";
import { dispatchRoutes } from "../../routes/table.ts";
import { createUpgrades } from "../../routes/upgrades.ts";
import { hostTimeout } from "../../testing/host-timeout.ts";
import { FixtureServer } from "../cdp/testing/fixtures.ts";
import { CHROME } from "../cdp/testing/real-chrome.ts";
import type { BrowserTarget } from "../service.ts";
import { jpegSize, startService, until, type RealService } from "../testing/real-service.ts";
import { StreamV2 } from "./stream-v2.ts";

const suite = CHROME ? describe : describe.skip;
const LOOPBACK = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
/** CDP modifier bits. */
const META = 4;
const CONTROL = 2;
const COPY_MODIFIER = process.platform === "darwin" ? META : CONTROL;

const STILL = `<!doctype html><title>still</title><style>html,body{margin:0;height:100%;background:#fff;font:16px system-ui}</style><p>still page</p>`;
const REPORT = `<!doctype html><title>report</title><style>html,body{margin:0;height:100%}#c{position:absolute;left:50%;top:50%;width:80px;height:80px;margin:-40px 0 0 -40px;background:#c33}</style><div id="c"></div>
<script>addEventListener("mousedown", (event) => { document.title = "at " + event.clientX + "," + event.clientY + (event.target.id === "c" ? " hit" : " miss") + " of " + innerWidth + "x" + innerHeight; });</script>`;
const ANIMATED = `<!doctype html><title>animated</title><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:60px;height:60px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div>`;
const FORM = `<!doctype html><title>form</title><style>body{margin:0}#f{position:absolute;left:20px;top:20px;width:240px;height:40px}#s{position:absolute;left:20px;top:100px;width:200px;height:30px}#d{position:absolute;left:20px;top:160px}#p{position:absolute;left:20px;top:220px;margin:0}</style>
<input id="f" type="file" multiple accept=".txt,text/plain">
<select id="s"><option>Apple</option><option>Banana</option><option>Cherry</option></select>
<a id="d" href="/report.csv">report</a>
<p id="p">copy these words</p>
<script>document.getElementById("s").addEventListener("change", (event) => { document.title = "chose " + event.target.value; });</script>`;

interface Client {
  socket: WebSocket;
  frames: Array<{ width: number; height: number }>;
  messages: Array<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  next<T extends Record<string, unknown>>(type: string, after?: number): Promise<T>;
  close(): Promise<void>;
}

suite("the v2 stream on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let server: Server;
  let origin = "";
  let target: BrowserTarget;
  let sessions = 0;
  const clients = new Set<Client>();

  beforeAll(async () => {
    fx = await FixtureServer.start();
    fx.route("/report.csv", { body: "a,b\n1,2\n", type: "text/csv", headers: { "content-disposition": "attachment; filename=\"report.csv\"" } });
    real = await startService({ screen: { width: 2560, height: 1600, deviceScaleFactor: 2 } });
    const stream = new StreamV2({ service: real.service });
    const upgrades = createUpgrades();
    const route = createBrowserViewerRoutes({
      upgrades,
      dataDir: real.dataDir,
      viewers: {
        open: async () => {},
        action: async () => ({ ok: true }),
        stream: ({ session: _session, spec: _spec, ...request }) => { stream.open({ ...request, target }); return true; },
        fileChooserOffered: (_browser, owner, chooser) => real.service.fileChooserOffered(target.session, owner, chooser),
        answerFileChooser: (_browser, owner, chooser, paths) => real.service.answerFileChooser(target.session, owner, chooser, paths),
        download: (_browser, id) => real.service.download(target.session, id),
      },
      audience: () => "team",
      browser: async (botId) => ({ botId, session: target.session, spec: { command: "omb-cdp", args: [target.key], env: {} } }),
      authorize: async () => null,
      current: () => true,
      restartRefusal: () => null,
    });
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: LOOPBACK, json, readBody })) json(res, 404, { error: "no route" });
    };
    server = createServer((req, res) => void handle(req, res));
    upgrades.attach(server, handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, hostTimeout(240_000));

  afterAll(async () => {
    // A test that failed midway leaves its socket open, and the server's close waits for every upgraded socket.
    for (const client of clients) await client.close();
    await new Promise<void>((resolve) => { if (!server) resolve(); else { server.close(() => resolve()); server.closeAllConnections(); } });
    await real?.close();
    await fx?.close();
  });

  async function opened(path: string, html: string): Promise<BrowserTarget> {
    target = { session: `stream-${++sessions}`, key: `bot:stream-${sessions}` };
    const result = await real.call(target, "agent_browser_open", { url: fx.page(path, html) });
    expect(result.isError, real.text(result)).toBeUndefined();
    return target;
  }

  function connect(query: string): Promise<Client> {
    const socket = new WebSocket(`ws://${origin}/api/bots/pepper/browser/stream?${query}`);
    socket.binaryType = "arraybuffer";
    const client: Client = {
      socket,
      frames: [],
      messages: [],
      send: (message) => socket.send(JSON.stringify(message)),
      next: (type, after = 0) => until(() => client.messages.slice(after).find((message) => message.type === type), (found) => found !== undefined) as never,
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
        socket.close();
        await closed;
      },
    };
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        client.messages.push(JSON.parse(event.data) as Record<string, unknown>);
        return;
      }
      // Acknowledged on arrival, as the panel does.
      socket.send("{\"type\":\"ack\"}");
      client.frames.push(jpegSize(Buffer.from(event.data as ArrayBuffer)));
    });
    clients.add(client);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(client));
      socket.addEventListener("error", () => reject(new Error("the stream did not open")));
    });
  }

  const pageSize = () => real.peek<[number, number, number]>(target, "[innerWidth, innerHeight, devicePixelRatio]");
  const same = (expected: unknown[]) => (actual: unknown[]) => JSON.stringify(actual) === JSON.stringify(expected);
  const takeControl = async (client: Client) => {
    client.send({ type: "takeControl" });
    await until(() => client.messages.filter((message) => message.type === "control").at(-1), (control) => control?.controller === "you");
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const click = (client: Client, x: number, y: number) => {
    client.send({ type: "mouse", action: "move", x, y, button: "none", buttons: 0, clickCount: 0, modifiers: 0 });
    client.send({ type: "mouse", action: "down", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    client.send({ type: "mouse", action: "up", x, y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
  };

  it("fills the panel: a 1600x1000 panel gets a 1600x1000 page and 3200x2000 frames on a 2x screen, and follows its resizes", async () => {
    await opened("/animated", ANIMATED);
    expect(await pageSize()).toEqual([1280, 800, 2]);
    const client = await connect("width=1600&height=1000&maxWidth=3200&maxHeight=2000");
    await until(pageSize, same([1600, 1000, 2]));
    await until(() => client.frames.at(-1), (frame) => frame?.width === 3200 && frame.height === 2000);
    expect(client.messages).toContainEqual(expect.objectContaining({ type: "viewport", width: 1600, height: 1000 }));
    // Watching is enough to size the page; nobody has to take control for it.
    client.send({ type: "resize", width: 1200, height: 900 });
    await until(pageSize, same([1200, 900, 2]));
    await until(() => client.frames.at(-1), (frame) => frame?.width === 2400 && frame.height === 1800);
    await client.close();
    await until(pageSize, same([1280, 800, 2]));
  }, hostTimeout(90_000));

  it("ends every drag of the panel on a sharp frame of the final size, on a page that never repaints by itself", async () => {
    await opened("/still", STILL);
    const client = await connect("width=1200&height=800&maxWidth=3200&maxHeight=2000");
    await until(pageSize, same([1200, 800, 2]));
    for (let trial = 0; trial < 6; trial++) {
      const grow = trial % 2 === 0;
      const sizes = Array.from({ length: 10 }, (_, step) => (grow ? [1240 + step * 40, 820 + step * 20] : [1560 - step * 40, 980 - step * 20]));
      for (const [width, height] of sizes) {
        client.send({ type: "resize", width, height });
        await sleep(150);
      }
      const [width, height] = sizes.at(-1)!;
      await until(pageSize, same([width, height, 2]));
      await until(() => client.frames.at(-1), (frame) => frame?.width === width! * 2 && frame.height === height! * 2, 3_000);
    }
    await client.close();
  }, hostTimeout(120_000));

  it("keeps the page of the person holding the browser when another view opens, and raises a frame cap in place", async () => {
    await opened("/held", STILL);
    const holder = await connect("width=1200&height=800&maxWidth=2400&maxHeight=1600");
    await takeControl(holder);
    await until(pageSize, same([1200, 800, 2]));
    const other = await connect("width=700&height=1000&maxWidth=1400&maxHeight=2000");
    await until(() => other.messages.filter((message) => message.type === "control").at(-1), (control) => control?.controller === "another-viewer");
    await sleep(1_000);
    expect(await pageSize()).toEqual([1200, 800, 2]);
    await other.close();
    holder.send({ type: "resize", width: 1512, height: 900 });
    holder.send({ type: "frameCap", maxWidth: 3024, maxHeight: 1800 });
    await until(() => holder.frames.at(-1), (frame) => frame?.width === 3024 && frame.height === 1800);
    expect(holder.messages.filter((message) => message.type === "control").at(-1)).toMatchObject({ controller: "you" });
    expect(real.service.heldBy(target.session)).not.toBeNull();
    await holder.close();
  }, hostTimeout(90_000));

  it("zooms a tab the person opens after zooming, so their click lands where they aim", async () => {
    await opened("/zoom", STILL);
    const client = await connect("width=1500&height=900&maxWidth=3000&maxHeight=1800");
    await takeControl(client);
    await until(pageSize, same([1500, 900, 2]));
    client.send({ type: "zoom", factor: 1.5 });
    await until(pageSize, same([1000, 600, 3]));
    const told = client.messages.filter((message) => message.type === "viewport").length;
    client.send({ type: "tabNew", url: fx.page("/zoom-tab", REPORT) });
    await until(() => real.peek<string>(target, "document.title"), (title) => title === "report");
    await until(pageSize, same([1000, 600, 3]));
    await until(() => client.messages.filter((message) => message.type === "viewport").slice(told).at(-1), (message) => message?.width === 1000 && message.height === 600 && message.zoom === 1.5);
    click(client, 500, 300);
    expect(await until(() => real.peek<string>(target, "document.title"), (title) => title.startsWith("at "))).toBe("at 500,300 hit of 1000x600");
    await client.close();
  }, hostTimeout(90_000));

  it("plays the picture in picture of the person holding a zoomed page, whose smaller stills leave the zoom alone", async () => {
    await opened("/pip", ANIMATED);
    const panel = await connect("width=1500&height=900&maxWidth=3000&maxHeight=1800");
    await takeControl(panel);
    panel.send({ type: "zoom", factor: 1.5 });
    await until(pageSize, same([1000, 600, 3]));
    const pip = await connect("maxWidth=1280&maxHeight=1280&interactive=false");
    await until(() => pip.frames.length, (count) => count >= 5);
    await sleep(1_000);
    expect(await pageSize()).toEqual([1000, 600, 3]);
    await pip.close();
    await panel.close();
  }, hostTimeout(90_000));

  it("sends the page's file picker to the person holding the browser, and their files to the page", async () => {
    await opened("/form", FORM);
    const client = await connect("width=1280&height=800&maxWidth=2560&maxHeight=1600");
    await takeControl(client);
    click(client, 120, 40);
    const chooser = await client.next<{ id: string; multiple: boolean; accept: string }>("fileChooser");
    expect(chooser).toMatchObject({ multiple: true, accept: ".txt,text/plain" });
    const body = new FormData();
    body.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    const answered = await fetch(`http://${origin}/api/bots/pepper/browser/upload?chooser=${chooser.id}`, { method: "POST", body });
    expect(answered.status).toBe(204);
    await until(() => real.peek<string[]>(target, "[...document.getElementById('f').files].map((file) => file.name)"), same(["notes.txt"]));
    await client.next("fileChooserClosed");
    const again = await fetch(`http://${origin}/api/bots/pepper/browser/upload?chooser=${chooser.id}`, { method: "POST", body });
    expect(again.status).toBe(409);
    await client.close();
  }, hostTimeout(90_000));

  it("draws a dropdown list for the viewer, and puts the option chosen there into the page", async () => {
    await opened("/form-select", FORM);
    const client = await connect("width=1280&height=800&maxWidth=2560&maxHeight=1600");
    await takeControl(client);
    click(client, 60, 115);
    const popup = await client.next<{ id: string; options: Array<{ label: string }>; selectedIndex: number; rect: { x: number; y: number; width: number; height: number } }>("selectPopup");
    expect(popup.options.map((option) => option.label)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(popup.selectedIndex).toBe(0);
    expect(popup.rect).toMatchObject({ x: 20, y: 100, width: 200, height: 30 });
    client.send({ type: "selectChoose", id: popup.id, index: 2 });
    await until(() => real.peek<string>(target, "document.title"), (title) => title === "chose Cherry");
    await client.close();
  }, hostTimeout(90_000));

  it("leaves a phone's press on a list to the page, as the v1 view always did", async () => {
    await opened("/form-phone", FORM.replace("</script>", "document.getElementById(\"s\").addEventListener(\"mousedown\", () => { document.title = \"pressed\"; });</script>"));
    const outputs: string[] = [];
    const viewer = await real.service.attachViewer(target, { owner: "phone", canOperate: true, maxWidth: 1280, maxHeight: 1280, pace: "lo" }, (output) => {
      outputs.push(output.type);
      if (output.type === "frame") output.ack();
    });
    await viewer.input({ type: "takeControl" });
    await viewer.input({ type: "mouse", action: "down", x: 60, y: 115, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    await viewer.input({ type: "mouse", action: "up", x: 60, y: 115, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
    await until(() => real.peek<string>(target, "document.title"), (title) => title === "pressed");
    expect(outputs).not.toContain("selectPopup");
    await viewer.input({ type: "releaseControl" });
    await viewer.close();
  }, hostTimeout(90_000));

  it("offers what the page downloaded to the person holding the browser, and serves the file", async () => {
    await opened("/form-download", FORM);
    const client = await connect("width=1280&height=800&maxWidth=2560&maxHeight=1600");
    await takeControl(client);
    click(client, 35, 168);
    const offered = await client.next<{ id: string; fileName: string; sizeBytes: number }>("download");
    expect(offered).toMatchObject({ fileName: "report.csv", sizeBytes: 8 });
    const file = await fetch(`http://${origin}/api/bots/pepper/browser/download/${offered.id}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("a,b\n1,2\n");
    await client.close();
  }, hostTimeout(90_000));

  it("shows the page's cursor, and sends what the page copied to the person's clipboard", async () => {
    await opened("/form-copy", FORM);
    const client = await connect("width=1280&height=800&maxWidth=2560&maxHeight=1600");
    await takeControl(client);
    client.send({ type: "mouse", action: "move", x: 35, y: 168, button: "none", buttons: 0, clickCount: 0, modifiers: 0 });
    expect(await client.next("cursor")).toEqual({ type: "cursor", shape: "pointer" });
    client.send({ type: "mouse", action: "down", x: 25, y: 228, button: "left", buttons: 1, clickCount: 3, modifiers: 0 });
    client.send({ type: "mouse", action: "up", x: 25, y: 228, button: "left", buttons: 0, clickCount: 3, modifiers: 0 });
    client.send({ type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: COPY_MODIFIER });
    client.send({ type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: COPY_MODIFIER });
    const copied = await client.next<{ text: string }>("clipboard");
    expect(copied.text.trim()).toBe("copy these words");
    await client.close();
  }, hostTimeout(90_000));
  it("keeps the panel's socket through an idle close and starts nothing by itself; the person's wake or the bot's next call shows the browser again", async () => {
    await opened("/still", STILL);
    const client = await connect("width=1200&height=800&maxWidth=2400&maxHeight=1600");
    await until(() => client.frames.length, (count) => count > 0);
    const asleep = async () => {
      const after = client.messages.length;
      await sleep(60);
      expect(await real.service.closeIdle(50)).toContain(target.key);
      await client.next("asleep", after);
      await sleep(1_000);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect(real.service.profiles().find((profile) => profile.key === target.key)?.run).toBeNull();
    };
    const shown = async (wake: () => Promise<unknown>) => {
      const after = client.messages.length;
      const frames = client.frames.length;
      await wake();
      await client.next("awake", after);
      await until(() => client.frames.length, (count) => count > frames);
    };
    await asleep();
    await shown(async () => client.send({ type: "wake" }));
    await asleep();
    await shown(async () => {
      const result = await real.call(target, "agent_browser_get_url");
      expect(result.isError, real.text(result)).toBeUndefined();
    });
    await client.close();
  }, hostTimeout(90_000));
});
