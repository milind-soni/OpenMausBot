// The v2 stream's routes, ported from pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowserStream.test.ts
// (MIT License, Copyright (c) 2026 T3 Tools Inc.): frames and acknowledgements over a real WebSocket, input only from a
// view that may operate, the file picker's upload, a download, and the host-setup close.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserHostError, SETUP_COMMAND } from "../browser/chrome/host-setup.ts";
import type { Audience } from "../audience.ts";
import type { Download } from "../browser/cdp/downloads.ts";
import type { BrowserService } from "../browser/service.ts";
import type { Viewer, ViewerOptions, ViewerOutput } from "../browser/viewers/core.ts";
import { STREAM_CLOSE, StreamV2 } from "../browser/viewers/stream-v2.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBrowserViewerRoutes, type BrowserViewerRouteDeps } from "./browser-viewers.ts";
import { dispatchRoutes } from "./table.ts";
import { createUpgrades } from "./upgrades.ts";

const LOOPBACK: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const FRAME = Buffer.from([255, 216, 255, 217]);
const METADATA = { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 };

const mutations = [
  { type: "resize", width: 390, height: 844 },
  { type: "mouse", action: "down", x: 10, y: 10, button: "left", buttons: 1 },
  { type: "key", action: "down", key: "Enter" },
  { type: "text", text: "reader must not type" },
  { type: "wheel", deltaY: 100 },
  { type: "navigate", url: "https://example.com" },
  { type: "history", delta: -1 },
  { type: "reload" },
  { type: "probe", x: 10, y: 10 },
  { type: "takeControl" },
  { type: "releaseControl" },
  { type: "dialog", accept: true },
  { type: "viewport", setting: { mode: "fill" } },
  { type: "selectChoose", id: "list", index: 1 },
];

interface Fixture {
  origin: string;
  stream: StreamV2;
  attachments: ViewerOptions[];
  inputs: unknown[];
  answers: Array<{ owner: string; chooser: string; files: Array<{ name: string; text: string }> }>;
  /** Uploads that reached the check for an offered picker. */
  pickerChecks: number;
  /** The v1 views opened, by the view each asked to carry on from. */
  resumes: Array<string | null | undefined>;
  /** Whose browser each view was opened on, and each check that the view still shows it. */
  opened: Audience[];
  checked: Audience[];
  /** The last v1 view's check that it still shows the browser it opened on. */
  isCurrent: () => boolean;
  dataDir: string;
}

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

async function serve({ attach, current = () => true, download, audience = () => "team" }: {
  attach?: (options: ViewerOptions, push: (output: ViewerOutput) => void) => Promise<Viewer>;
  current?: () => boolean;
  download?: (id: string) => Download | undefined;
  audience?: (threadId: string | null) => Audience | null;
} = {}): Promise<Fixture> {
  const fixture = { origin: "", attachments: [], inputs: [], answers: [], pickerChecks: 0, resumes: [], opened: [], checked: [], dataDir: mkdtempSync(join(tmpdir(), "omb-browser-viewers-")) } as unknown as Fixture;
  folders.push(fixture.dataDir);
  const viewer = { id: "viewer", input: async (message: unknown) => { fixture.inputs.push(message); }, close: async () => {} } as unknown as Viewer;
  const service = {
    attachViewer: async (_target: unknown, options: ViewerOptions, push: (output: ViewerOutput) => void) => {
      fixture.attachments.push(options);
      return attach ? attach(options, push) : viewer;
    },
    restart: async () => {},
  } as unknown as BrowserService;
  const stream = new StreamV2({ service });
  fixture.stream = stream;
  const upgrades = createUpgrades();
  const deps: BrowserViewerRouteDeps = {
    upgrades,
    dataDir: fixture.dataDir,
    viewers: {
      open: async (options) => {
        fixture.resumes.push(options.resume);
        fixture.isCurrent = options.isCurrent;
        options.res.writeHead(204).end();
      },
      action: async () => ({ ok: true }),
      stream: ({ session, spec: _spec, ...request }) => {
        stream.open({ ...request, target: { session, key: "bot:pepper" } });
        return true;
      },
      fileChooserOffered: (_browser, _owner, chooser) => {
        fixture.pickerChecks++;
        return chooser === "chooser-1";
      },
      answerFileChooser: async (_browser, owner, chooser, paths) => {
        fixture.answers.push({ owner, chooser, files: paths.map((path) => ({ name: basename(path), text: readFileSync(path, "utf8") })) });
        return chooser === "chooser-1";
      },
      download: (_browser, id) => download?.(id),
    },
    audience: (_auth, threadId) => audience(threadId),
    browser: async (botId, opened) => {
      fixture.opened.push(opened);
      return botId === "pepper" ? { botId, session: "bot-pepper", spec: { command: "omb-cdp", args: ["bot:pepper"], env: {} } } : { status: 404, error: "no such bot" };
    },
    authorize: async () => null,
    current: (_botId, _session, _auth, checked) => { fixture.checked.push(checked); return current(); },
    restartRefusal: () => null,
  };
  const route = createBrowserViewerRoutes(deps);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: LOOPBACK, json, readBody })) json(res, 404, { error: "no route" });
  };
  const server = createServer((req, res) => void handle(req, res));
  upgrades.attach(server, handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fixture;
}

/** A client that keeps its socket after the server's close frame: it reads what the server sends and never answers. */
function stubbornStream(fixture: Fixture): Promise<Socket> {
  const [host, port] = fixture.origin.split(":");
  return new Promise((resolve, reject) => {
    const req = request({ host, port: Number(port), path: "/api/bots/pepper/browser/stream", headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
    req.once("upgrade", (_res, socket) => resolve((socket as Socket).resume()));
    req.once("response", (res) => reject(new Error(`refused: ${res.statusCode}`)));
    req.once("error", reject);
    req.end();
  });
}

/** One masked text frame, as a client sends it. */
function textFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const mask = Buffer.from([7, 1, 8, 3]);
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((byte, index) => byte ^ mask[index % 4]!)]);
}

const until = async (check: () => boolean, timeoutMs = 5_000) => {
  for (const deadline = Date.now() + timeoutMs; !check(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > deadline) throw new Error("timed out");
  }
};

const withResolvers = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("the v2 stream", () => {
  it.each([{ interactive: true }, { interactive: false }])("streams frames and acks while gating page mutations (%s)", async ({ interactive }) => {
    const acked = withResolvers();
    const fixture = await serve({
      attach: async (_options, push) => {
        push({ type: "viewport", width: 1280, height: 800, setting: { mode: "fill" }, zoom: 1 });
        push({ type: "frame", data: FRAME, metadata: METADATA, still: false, ack: () => acked.resolve() });
        return { id: "viewer", input: async (message: unknown) => { fixture.inputs.push(message); }, close: async () => {} } as unknown as Viewer;
      },
    });
    const socket = new WebSocket(`ws://${fixture.origin}/api/bots/pepper/browser/stream?width=1600&height=1000${interactive ? "" : "&interactive=false"}`);
    socket.binaryType = "arraybuffer";
    const texts: unknown[] = [];
    const frames: Uint8Array[] = [];
    const received = withResolvers();
    socket.addEventListener("error", () => received.reject(new Error("stream failed")));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        texts.push(JSON.parse(event.data));
        return;
      }
      frames.push(new Uint8Array(event.data as ArrayBuffer));
      for (const message of mutations) socket.send(JSON.stringify(message));
      socket.send("malformed input");
      socket.send(JSON.stringify({ type: "ack" }));
      received.resolve();
    });
    await received.promise;
    // The ack follows every mutation on the socket, so it is also a barrier proving all preceding inputs were read.
    await acked.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.close();
    expect(frames).toEqual([new Uint8Array(FRAME)]);
    expect(texts).toEqual([{ type: "viewport", width: 1280, height: 800, setting: { mode: "fill" }, zoom: 1 }]);
    expect(fixture.inputs).toEqual(interactive ? [...mutations, null] : []);
    expect(fixture.attachments).toEqual([{
      owner: "local-owner", canOperate: interactive, maxWidth: 1280, maxHeight: 800, quality: 70, pace: "hi", authPrompts: true, pagePopups: true,
      ...(interactive ? { size: { width: 1600, height: 1000 } } : {}),
    }]);
  });

  it("refuses an upgrade from another origin, and a plain request, before attaching a viewer", async () => {
    const fixture = await serve();
    const refused = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://${fixture.origin}/api/bots/pepper/browser/stream`, { headers: { origin: "https://attacker.invalid" } } as unknown as string[]);
      socket.addEventListener("open", () => { resolve(0); socket.close(); });
      socket.addEventListener("close", (event) => resolve(event.code));
    });
    expect(refused).toBe(1006);
    expect((await fetch(`http://${fixture.origin}/api/bots/pepper/browser/stream`)).status).toBe(426);
    expect(fixture.attachments).toEqual([]);
  });

  it("closes a view whose browser is gone for good, and reconnects one whose browser restarted", async () => {
    let current = true;
    const pushes: Array<(output: ViewerOutput) => void> = [];
    const fixture = await serve({
      current: () => current,
      attach: async (_options, push) => {
        pushes.push(push);
        return { id: "viewer", input: async () => {}, close: async () => {} } as unknown as Viewer;
      },
    });
    const closed = (socket: WebSocket) => new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    const restarted = new WebSocket(`ws://${fixture.origin}/api/bots/pepper/browser/stream`);
    await new Promise((resolve) => restarted.addEventListener("open", resolve));
    while (!pushes[0]) await new Promise((resolve) => setTimeout(resolve, 5));
    const reconnect = closed(restarted);
    pushes[0]({ type: "gone", reason: "closed" });
    expect(await reconnect).toBe(STREAM_CLOSE.reconnect);
    current = false;
    const stale = new WebSocket(`ws://${fixture.origin}/api/bots/pepper/browser/stream`);
    expect(await closed(stale)).toBe(1006);
  });

  it("lets a closed view go at once: its input stops reaching the browser, and a client that keeps its socket is cut off", async () => {
    let closes = 0;
    const fixture = await serve({
      attach: async () => ({ id: "viewer", input: async (message: unknown) => { fixture.inputs.push(message); }, close: async () => { closes++; } }) as unknown as Viewer,
    });
    const socket = await stubbornStream(fixture);
    const ended = new Promise<number>((resolve) => socket.once("close", () => resolve(Date.now())));
    socket.write(textFrame({ type: "takeControl" }));
    await until(() => fixture.inputs.length === 1);
    const closedAt = Date.now();
    fixture.stream.closeForOwner("local-owner");
    expect(closes).toBe(1);
    socket.write(textFrame({ type: "navigate", url: "https://after-sign-out.example/" }));
    expect(await ended - closedAt).toBeLessThan(5_000);
    expect(fixture.inputs).toEqual([{ type: "takeControl" }]);
  });

  it("checks each message as each v1 action is checked: a person who may no longer see the bot is cut off at once", async () => {
    let current = true;
    const fixture = await serve({ current: () => current });
    const opened = async () => {
      const socket = new WebSocket(`ws://${fixture.origin}/api/bots/pepper/browser/stream`);
      await new Promise((resolve) => socket.addEventListener("open", resolve));
      return { socket, closed: new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code))) };
    };
    const first = await opened();
    first.socket.send(JSON.stringify({ type: "takeControl" }));
    await until(() => fixture.inputs.length === 1);
    current = false;
    first.socket.send(JSON.stringify({ type: "navigate", url: "https://hidden.example/" }));
    expect(await first.closed).toBe(STREAM_CLOSE.gone);
    expect(fixture.inputs).toEqual([{ type: "takeControl" }]);
    current = true;
    const second = await opened();
    current = false;
    const recheckedAt = Date.now();
    fixture.stream.recheck();
    expect(await second.closed).toBe(STREAM_CLOSE.gone);
    expect(Date.now() - recheckedAt).toBeLessThan(1_000);
  });

  it.each([
    { error: new BrowserHostError("sandbox"), need: "sandbox" },
    { error: new BrowserHostError("libraries", ["libnss3.so"]), need: "libraries" },
  ])("tells viewers the command that sets up the host ($need)", async ({ error, need }) => {
    const fixture = await serve({ attach: async () => { throw error; } });
    const socket = new WebSocket(`ws://${fixture.origin}/api/bots/pepper/browser/stream`);
    const { code, reason } = await new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
    expect(code).toBe(STREAM_CLOSE.hostSetup);
    expect(JSON.parse(reason)).toEqual({ need, command: SETUP_COMMAND });
  });
});

describe("the v1 live view", () => {
  it("passes on the view a reconnecting panel had, so its dropped hold can be returned", async () => {
    const fixture = await serve();
    expect((await fetch(`http://${fixture.origin}/api/bots/pepper/browser/live?resume=old-viewer`)).status).toBe(204);
    expect((await fetch(`http://${fixture.origin}/api/bots/pepper/browser/live`)).status).toBe(204);
    expect(fixture.resumes).toEqual(["old-viewer", null]);
  });
});

describe("the page's file picker and downloads", () => {
  it("passes uploaded files to the page's open picker, which only its current id answers", async () => {
    const fixture = await serve();
    const upload = (chooser: string) => {
      const body = new FormData();
      body.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
      return fetch(`http://${fixture.origin}/api/bots/pepper/browser/upload?chooser=${chooser}`, { method: "POST", body });
    };
    expect((await upload("chooser-1")).status).toBe(204);
    expect(fixture.answers).toEqual([{ owner: "local-owner", chooser: "chooser-1", files: [{ name: "notes.txt", text: "hello" }] }]);
    const stale = await upload("stale");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "The page's file picker is no longer open." });
    // The answered upload's file stays for the page to read; the refused one's is gone.
    expect(readdirSync(join(fixture.dataDir, "browser-uploads"))).toHaveLength(1);
    expect((await fetch(`http://${fixture.origin}/api/bots/pepper/browser/upload?chooser=chooser-1`, { method: "POST", body: "plain" })).status).toBe(415);
    expect((await fetch(`http://${fixture.origin}/api/bots/nobody/browser/upload?chooser=chooser-1`, { method: "POST" })).status).toBe(404);
  });

  it("refuses an upload for a picker this person was not offered before reading any of it", async () => {
    const fixture = await serve();
    const [host, port] = fixture.origin.split(":");
    const body = request({ host, port: Number(port), method: "POST", path: "/api/bots/pepper/browser/upload?chooser=bogus", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(90 * 1024 * 1024) } });
    body.on("error", () => {});
    const answered = new Promise<number>((resolve) => body.once("response", (res) => { res.resume(); resolve(res.statusCode!); }));
    body.write(Buffer.alloc(64 * 1024));
    expect(await answered).toBe(409);
    body.destroy();
    expect(fixture.answers).toEqual([]);
    expect(existsSync(join(fixture.dataDir, "browser-uploads"))).toBe(false);
  });

  it("takes one upload at a time from each person", async () => {
    const fixture = await serve();
    const [host, port] = fixture.origin.split(":");
    const head = "--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\nhello";
    const tail = "\r\n--x--\r\n";
    const first = request({ host, port: Number(port), method: "POST", path: "/api/bots/pepper/browser/upload?chooser=chooser-1", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(Buffer.byteLength(head + tail)) } });
    const firstAnswered = new Promise<number>((resolve) => first.once("response", (res) => { res.resume(); resolve(res.statusCode!); }));
    first.write(head);
    await until(() => fixture.pickerChecks === 1);
    const second = new FormData();
    second.append("file", new File(["again"], "again.txt"));
    const refused = await fetch(`http://${fixture.origin}/api/bots/pepper/browser/upload?chooser=chooser-1`, { method: "POST", body: second });
    expect(refused.status).toBe(429);
    first.end(tail);
    expect(await firstAnswered).toBe(204);
    expect(fixture.answers).toEqual([{ owner: "local-owner", chooser: "chooser-1", files: [{ name: "notes.txt", text: "hello" }] }]);
  });

  it("refuses more than 20 files at once", async () => {
    const fixture = await serve();
    const body = new FormData();
    for (let i = 0; i < 21; i++) body.append("file", new File(["x"], `f${i}.txt`));
    const response = await fetch(`http://${fixture.origin}/api/bots/pepper/browser/upload?chooser=chooser-1`, { method: "POST", body });
    expect(response.status).toBe(413);
    expect(fixture.answers).toEqual([]);
  });

  it("serves a finished download as an attachment, and nothing else", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-download-"));
    folders.push(folder);
    const path = join(folder, "Q3 report.csv");
    writeFileSync(path, "report contents");
    const fixture = await serve({
      download: (id) => (id === "download-1" ? { id, fileName: "Q3 report.csv", path, receivedBytes: 15, state: "completed" } as Download : undefined),
    });
    const response = await fetch(`http://${fixture.origin}/api/bots/pepper/browser/download/download-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"Q3 report.csv\"; filename*=UTF-8''Q3%20report.csv");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("report contents");
    expect((await fetch(`http://${fixture.origin}/api/bots/pepper/browser/download/other`)).status).toBe(404);
  });
});

describe("whose browser a view shows on a Team Cloud", () => {
  it("opens the browser of the conversation shown, the person's own with none named, and nothing for a conversation hidden from them", async () => {
    const hidden = new Set(["cleo-chat"]);
    const fixture = await serve({ audience: (threadId) => (threadId === null ? "member:p_ada" : hidden.has(threadId) ? null : threadId === "room-chat" ? "room:launch" : "member:p_ada") });
    const get = (query: string) => fetch(`http://${fixture.origin}/api/bots/pepper/browser/live${query}`).then((res) => res.status);
    expect(await get("?threadId=ada-chat")).toBe(204);
    expect(await get("?threadId=room-chat")).toBe(204);
    expect(await get("")).toBe(204);
    expect(await get("?threadId=cleo-chat"), "a member never reaches another member's browser").toBe(404);
    expect(fixture.opened).toEqual(["member:p_ada", "room:launch", "member:p_ada"]);
  });

  it("ends a view once its conversation is hidden from the person, and checks the browser for that same audience", async () => {
    let sees = true;
    const fixture = await serve({ audience: (threadId) => (threadId === "ada-chat" && sees ? "member:p_ada" : threadId === null ? "team" : null) });
    const act = () => fetch(`http://${fixture.origin}/api/bots/pepper/browser/action?threadId=ada-chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewerId: "v-1", type: "key" }) }).then((res) => res.status);
    expect(await act()).toBe(200);
    expect(fixture.checked).toEqual(["member:p_ada"]);
    expect((await fetch(`http://${fixture.origin}/api/bots/pepper/browser/live?threadId=ada-chat`)).status).toBe(204);
    expect(fixture.isCurrent()).toBe(true);
    sees = false;
    expect(fixture.isCurrent(), "an open view stops showing a conversation the person no longer sees").toBe(false);
    expect(await act()).toBe(404);
    expect(fixture.opened).toEqual(["member:p_ada", "member:p_ada"]);
  });
});
