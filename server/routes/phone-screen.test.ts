import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { distrustHomePrograms } from "../bot-box/program-trust.ts";
import { json, readBody } from "../harness/http.ts";
import { createPhoneHold, type PhoneHold } from "../phone-screen/hold.ts";
import { resolveRequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensureScrcpyServer } from "../phone-screen/scrcpy-server-file.ts";
import { control, KEYCODES, SCRCPY_SERVER } from "../phone-screen/scrcpy-wire.ts";
import { fakePhone, usbPhoneLine, videoFrame, videoSession } from "../testing/fake-phone.ts";
import { SCRCPY_VIDEO_PACKETS } from "../testing/scrcpy-video.ts";
import { createPhoneScreenRoutes } from "./phone-screen.ts";
import { dispatchRoutes } from "./table.ts";
import { createUpgrades } from "./upgrades.ts";

const SERIAL = "PHONE1";
const STREAM = `/api/usb-phones/${SERIAL}/stream`;
const OWNER_TOKEN = "owner-token-123";
const DESKTOP_APP = { "x-openmausbot-desktop-owner": OWNER_TOKEN };
const DEVICES = [
  usbPhoneLine(SERIAL),
  usbPhoneLine("LOCKED", "unauthorized"),
  usbPhoneLine("ASLEEP", "offline"),
  "emulator-5554\tdevice product:sdk_gphone64 model:sdk_gphone64 transport_id:7",
  "192.168.1.20:5555\tdevice product:husky model:Pixel_8_Pro transport_id:8",
].join("\n");
const RECORDED = SCRCPY_VIDEO_PACKETS.slice(1) as Array<{ kind: "config" | "key" | "delta"; data: Buffer }>;
const TAG = { config: 1, key: 2, delta: 3 };
const tagged = ({ kind, data }: { kind: "config" | "key" | "delta"; data: Buffer }) => Buffer.concat([Buffer.from([TAG[kind]]), data]);
const MINUTE = 60_000;
const TAKE = { type: "take" };
const hex = (...messages: Buffer[]) => Buffer.concat(messages).toString("hex");
const touch = (action: "down" | "move" | "up", x: number, y: number, w = 720, h = 1280) => ({ type: "touch", action, x, y, w, h });
const TOUCH_BYTES = 32;
const KEY_BYTES = 28;
const HELD = { type: "control", held: true };
const FREE = { type: "control", held: false };

/** What has arrived so far, and a wait for the first `count` of it. */
function arrivals<T>() {
  const all: T[] = [];
  const waiting = new Set<() => void>();
  return {
    all,
    add(item: T) {
      all.push(item);
      for (const check of waiting) check();
    },
    has: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (all.length < count) return;
          waiting.delete(check);
          resolve();
        };
        waiting.add(check);
        check();
      }),
  };
}

interface Fixture {
  /** The fixture's own temporary folder, removed after the test. */
  home: string;
  origin: string;
  phone: ReturnType<typeof fakePhone>;
  /** Mutable: what `features.usbPhoneTakeover` is right now. */
  flag: { on: boolean };
  /** How often the scrcpy server file was asked for. */
  serverFileAsks: number;
  sessions: SessionRegistry;
  hold: PhoneHold;
  /** Each `open` the routes told the hold's `watched`. */
  watched: ReturnType<typeof arrivals<boolean>>;
  screen: ReturnType<typeof createPhoneScreenRoutes>;
  /** The headers of a paired device with these scopes, and its session's id. */
  paired(scopes?: Array<"admin" | "client">): { headers: { authorization: string }; sessionId: string };
}

const servers: Server[] = [];
const folders: string[] = [];
const sockets: Array<() => void> = [];
/** Ends each wait of a fixture whose phones' screens never open. */
const waitsForTheScreen: Array<() => void> = [];
let fixture: Fixture | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  distrustHomePrograms(null);
  for (const drop of sockets.splice(0)) drop();
  for (const end of waitsForTheScreen.splice(0)) end();
  await fixture?.screen.closeAll();
  fixture?.hold.stop();
  fixture?.sessions.close();
  fixture = undefined;
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

/** A scrcpy server file that is still being fetched when the test ends: streams open, and no phone's screen does. */
const neverOpens = () =>
  new Promise<string>((_resolve, reject) => {
    waitsForTheScreen.push(() => reject(new Error("The test ended.")));
  });

async function serve({ flag = true, mode = "", devices = DEVICES, adbPath, serverFile }: { flag?: boolean; mode?: string; devices?: string; adbPath?: () => string | null; serverFile?: () => Promise<string> } = {}): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "omb-phone-screen-"));
  folders.push(home);
  const phone = fakePhone({ mode, devices, under: home });
  vi.stubEnv("OMB_ADB_PATH", phone.adbPath);
  const sessions = new SessionRegistry({ file: join(home, "sessions.json") });
  const upgrades = createUpgrades();
  const hold = createPhoneHold({ onChange: (held) => made.screen.holdChanged(held) });
  const watched = arrivals<boolean>();
  const made: Fixture = {
    home,
    origin: "",
    phone,
    flag: { on: flag },
    serverFileAsks: 0,
    sessions,
    hold,
    watched,
    screen: createPhoneScreenRoutes({
      upgrades,
      hold: { get held() { return hold.held; }, take: hold.take, release: hold.release, used: hold.used, watched: (open) => { hold.watched(open); watched.add(open); } },
      enabled: () => made.flag.on,
      live: (auth) => auth.kind === "loopback" || sessions.isLive(auth.session.id),
      dataDir: home,
      serverFile: async () => {
        made.serverFileAsks += 1;
        return serverFile ? serverFile() : phone.serverFile;
      },
      ...(adbPath ? { adbPath } : {}),
    }),
    paired(scopes = ["admin", "client"]) {
      const { code } = sessions.openPairing({ scopes });
      const result = sessions.exchange({ code, label: "test", source: "127.0.0.1" });
      if (!result.ok) throw new Error(result.error);
      return { headers: { authorization: `Bearer ${result.token}` }, sessionId: result.session.id };
    },
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { auth, status, error } = resolveRequestAuth(req, { sessions, cookieName: "omb_session", streamPath: "/api/events", url, loopbackMutationToken: OWNER_TOKEN });
    if (!auth) return json(res, status, { error });
    if (!await dispatchRoutes([made.screen.route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { error: "no route" });
  };
  const server = createServer((req, res) => void handle(req, res));
  upgrades.attach(server, handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  made.origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (fixture = made);
}

/** A stream as a WebSocket client sees it: `messages` are the binary ones, `said` the JSON ones. */
function stream(served: Fixture, { path = STREAM, headers = DESKTOP_APP as Record<string, string> } = {}) {
  const socket = new WebSocket(`ws://${served.origin}${path}`, { headers });
  sockets.push(() => socket.terminate());
  const video = arrivals<Buffer>();
  const said = arrivals<unknown>();
  socket.on("message", (data, isBinary) => {
    if (isBinary) video.add(data as Buffer);
    else said.add(JSON.parse(data.toString()));
  });
  const tell = (message: unknown) => socket.send(JSON.stringify(message));
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once("error", reject);
  });
  closed.catch(() => {});
  const refused = new Promise<{ status: number; body: string }>((resolve) => {
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
  });
  return { socket, messages: video.all, has: video.has, said, tell, closed, refused };
}

/** A client that upgrades and then says nothing: it answers no ping and no close frame. */
function silentStream(served: Fixture): Promise<Socket> {
  const [host, port] = served.origin.split(":");
  return new Promise((resolve, reject) => {
    const upgrade = request({
      host, port: Number(port), path: STREAM,
      headers: { ...DESKTOP_APP, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
    });
    upgrade.once("upgrade", (_response, socket) => {
      sockets.push(() => socket.destroy());
      resolve((socket as Socket).resume());
    });
    upgrade.once("response", (response) => reject(new Error(`refused: ${response.statusCode}`)));
    upgrade.once("error", reject);
    upgrade.end();
  });
}

const get = async (served: Fixture, path: string, headers: Record<string, string> = {}, method = "GET") => {
  const response = await fetch(`http://${served.origin}${path}`, { method, headers });
  return { status: response.status, body: await response.json() as unknown };
};

describe("the USB phone routes", () => {
  it("are absent while the flag is off, with no adb call and no download, and answer once it is on", async () => {
    const served = await serve({ flag: false });

    expect(await get(served, "/api/usb-phones")).toEqual({ status: 404, body: { error: "no route" } });
    expect((await stream(served).refused).status).toBe(404);
    expect(served.phone.calls()).toEqual([]);
    expect(served.serverFileAsks).toBe(0);

    served.flag.on = true;
    expect(await get(served, "/api/usb-phones")).toEqual({
      status: 200,
      body: {
        available: true,
        devices: [
          { serial: SERIAL, state: "device", connection: "usb", model: "Pixel 8 Pro" },
          { serial: "LOCKED", state: "unauthorized", connection: "usb", model: "Android device" },
          { serial: "ASLEEP", state: "offline", connection: "usb", model: "Android device" },
        ],
      },
    });
    const watching = stream(served);
    await watching.has(RECORDED.length);
    expect(watching.messages).toEqual(RECORDED.map(tagged));
  });

  it("send each video packet as one binary message under its tag: the config packet, the key frame, then the deltas, old and new", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);

    expect(watching.messages[0]).toEqual(Buffer.concat([Buffer.from([1]), RECORDED[0]!.data]));
    expect(watching.messages[1]).toEqual(Buffer.concat([Buffer.from([2]), RECORDED[1]!.data]));
    expect(watching.messages.slice(2)).toEqual(RECORDED.slice(2).map(({ data }) => Buffer.concat([Buffer.from([3]), data])));

    const second = stream(served);
    await second.has(RECORDED.length);
    const live = { kind: "delta" as const, data: Buffer.from("delta 11") };
    await served.phone.send(videoFrame(live.kind, live.data));
    await Promise.all([watching.has(RECORDED.length + 1), second.has(RECORDED.length + 1)]);
    expect(second.messages).toEqual([...RECORDED, live].map(tagged));
    expect(served.phone.calls().filter((call) => call[2] === "push")).toHaveLength(1);
  });

  it("ignore a message that is not JSON, and end a stream whose client sends more than 4 KiB", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);
    const before = served.phone.calls().length;

    watching.socket.send(Buffer.alloc(4 * 1024));
    watching.socket.send(Buffer.from(JSON.stringify({ type: "take" })));
    watching.socket.send("take");
    watching.socket.send("null");
    await served.phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await watching.has(RECORDED.length + 1);
    expect(served.hold.held).toBe(false);

    watching.socket.send(Buffer.alloc(4 * 1024 + 1));
    expect((await watching.closed).code).toBe(1009);
    await served.screen.closeAll();
    expect(served.phone.calls().slice(before).map((call) => call.slice(2, 4))).toEqual([["shell", "rm"]]);
  });

  it("tell every stream who holds the phone: when it opens, and when any stream takes the phone or hands it back", async () => {
    const served = await serve();
    const first = stream(served);
    const second = stream(served);
    await Promise.all([first.said.has(1), second.said.has(1)]);
    expect([first.said.all, second.said.all]).toEqual([[FREE], [FREE]]);

    first.tell({ type: "take" });
    await Promise.all([first.said.has(2), second.said.has(2)]);
    expect(served.hold.held).toBe(true);
    const third = stream(served);
    await third.said.has(1);
    expect(third.said.all).toEqual([HELD]);

    second.tell({ type: "handBack" });
    await Promise.all([first.said.has(3), second.said.has(3), third.said.has(2)]);
    expect(served.hold.held).toBe(false);
    expect([first.said.all, second.said.all, third.said.all]).toEqual([[FREE, HELD, FREE], [FREE, HELD, FREE], [HELD, FREE]]);
  });

  it("keep a hold while a stream of any phone is open, and end it once none has been open for 2 minutes", async () => {
    const served = await serve({ devices: [usbPhoneLine(SERIAL), usbPhoneLine("PHONE2")].join("\n"), serverFile: neverOpens });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = stream(served);
    first.socket.once("open", () => first.tell({ type: "take" }));
    await first.said.has(2);
    const other = stream(served, { path: "/api/usb-phones/PHONE2/stream" });
    await other.said.has(1);

    first.socket.close();
    await first.closed;
    vi.advanceTimersByTime(2 * MINUTE);
    expect(served.hold.held).toBe(true);

    other.socket.close();
    await served.watched.has(3);
    expect(served.watched.all).toEqual([true, true, false]);
    vi.advanceTimersByTime(2 * MINUTE - 1);
    expect(served.hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(served.hold.held).toBe(false);
  });

  it("keep a hold whose streams all closed when one opens again within 2 minutes", async () => {
    const served = await serve({ serverFile: neverOpens });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = stream(served);
    first.socket.once("open", () => first.tell({ type: "take" }));
    await first.said.has(2);

    first.socket.close();
    await served.watched.has(2);
    vi.advanceTimersByTime(2 * MINUTE - 1_000);
    const back = stream(served);
    await back.said.has(1);
    expect(back.said.all).toEqual([HELD]);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(served.hold.held).toBe(true);
  });

  it("send the phone nothing for input while nobody holds it", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);

    watching.tell(touch("down", 360, 640));
    watching.tell(touch("move", 361, 641));
    watching.tell(touch("up", 361, 641));
    watching.tell({ type: "key", key: "home" });
    watching.tell({ type: "text", text: "hi" });
    watching.tell(TAKE);
    watching.tell({ type: "key", key: "back" });

    expect(await served.phone.control(KEY_BYTES)).toBe(hex(control.key(KEYCODES.back)));
  });

  it.each([
    ["a touch at the frame's width", touch("down", 720, 640)],
    ["a touch at the frame's height", touch("down", 360, 1280)],
    ["a touch left of the frame", touch("down", -1, 640)],
    ["a touch above the frame", touch("down", 360, -1)],
    ["a touch at a number that is not finite", '{"type":"touch","action":"down","x":1e999,"y":640,"w":720,"h":1280}'],
    ["a touch whose place is not a number", { ...touch("down", 360, 640), x: "360" }],
    ["a touch on a frame without width", touch("down", 0, 640, 0, 1280)],
    ["a touch on a frame without height", touch("down", 360, 0, 720, 0)],
    ["a touch on a frame wider than 65535", touch("down", 360, 640, 65_536, 1280)],
    ["a touch on a frame taller than 65535", touch("down", 360, 640, 720, 65_536)],
    ["a touch that is neither down, move nor up", { ...touch("down", 360, 640), action: "press" }],
    ["a move with no finger down", touch("move", 360, 640)],
    ["a lift with no finger down", touch("up", 360, 640)],
    ["a key the phone panel does not have", { type: "key", key: "power" }],
    ["a key named like a property of every object", { type: "key", key: "constructor" }],
    ["a key that is not a name", { type: "key", key: 4 }],
    ["an empty text", { type: "text", text: "" }],
    ["a text of 301 characters", { type: "text", text: "a".repeat(301) }],
    ["a text that is not a string", { type: "text", text: 7 }],
    ["a message of no known type", { type: "scroll", x: 1, y: 1 }],
  ])("send the phone nothing for %s, though a person holds it", async (_what, invalid) => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);

    watching.tell(TAKE);
    watching.socket.send(typeof invalid === "string" ? invalid : JSON.stringify(invalid));
    watching.tell({ type: "key", key: "back" });

    expect(await served.phone.control(KEY_BYTES)).toBe(hex(control.key(KEYCODES.back)));
  });

  it("leave a finger down, and send the phone nothing, for a touch that is neither down, move nor up", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);

    watching.tell(TAKE);
    watching.tell(touch("down", 100, 200));
    watching.tell({ ...touch("move", 110, 210), action: "cancel" });
    watching.tell({ type: "key", key: "back" });

    expect(await served.phone.control(TOUCH_BYTES + KEY_BYTES)).toBe(hex(control.touch("down", 100, 200, 720, 1280), control.key(KEYCODES.back)));
  });

  it("send the phone nothing for input that arrives once the flag is off, though the stream has not been closed yet", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);
    watching.tell(TAKE);
    await watching.said.has(2);

    served.flag.on = false;
    watching.tell(touch("down", 100, 200));
    watching.tell({ type: "key", key: "home" });

    expect((await watching.closed).code).toBe(4404);
    await served.screen.closeAll();
    expect(await served.phone.control(0)).toBe("");
  });

  it("let a stream refused as a phone's fifth view take nothing", async () => {
    const served = await serve({ serverFile: neverOpens });
    const four = [stream(served), stream(served), stream(served), stream(served)];
    await Promise.all(four.map((watching) => watching.said.has(1)));

    const fifth = stream(served);
    fifth.socket.once("open", () => fifth.tell(TAKE));

    expect(await fifth.closed).toEqual({ code: 1013, reason: "Too many views of this phone are open. Close another one first." });
    expect(served.hold.held).toBe(false);
  });

  it("send a held phone the touches, keys and text of any stream, each as scrcpy's message for it", async () => {
    const served = await serve();
    const taker = stream(served);
    const other = stream(served);
    await Promise.all([taker.has(RECORDED.length), other.has(RECORDED.length)]);
    taker.tell(TAKE);
    await other.said.has(2);

    other.tell(touch("down", 100, 200));
    other.tell(touch("move", 110.5, 210.5));
    other.tell(touch("up", 120, 220));
    const touches = hex(control.touch("down", 100, 200, 720, 1280), control.touch("move", 110, 210, 720, 1280), control.touch("up", 120, 220, 720, 1280));
    expect(await served.phone.control(3 * TOUCH_BYTES)).toBe(touches);

    taker.tell({ type: "key", key: "home" });
    taker.tell({ type: "text", text: "a".repeat(300) });
    taker.tell({ type: "text", text: "你好" });
    const typed = hex(control.key(KEYCODES.home), control.text("a".repeat(300)), control.paste("你好"));
    expect(await served.phone.control((touches.length + typed.length) / 2)).toBe(touches + typed);
  });

  it("lift a finger that is down when its stream closes and when the hold ends, where it was, at the phone's own video size", async () => {
    const served = await serve();
    const taker = stream(served);
    const other = stream(served);
    await Promise.all([taker.has(RECORDED.length), other.has(RECORDED.length)]);
    taker.tell(TAKE);
    await other.said.has(2);

    other.tell(touch("down", 100, 200));
    other.socket.close();
    const closed = hex(control.touch("down", 100, 200, 720, 1280), control.touch("up", 100, 200, 720, 1280));
    expect(await served.phone.control(2 * TOUCH_BYTES)).toBe(closed);

    taker.tell(touch("down", 5, 6));
    taker.tell(touch("move", 700, 1200));
    taker.tell({ type: "handBack" });
    const handedBack = hex(control.touch("down", 5, 6, 720, 1280), control.touch("move", 700, 1200, 720, 1280), control.touch("up", 700, 1200, 720, 1280));
    expect(await served.phone.control(5 * TOUCH_BYTES)).toBe(closed + handedBack);
  });

  it("lift a finger that is down before stopping scrcpy for the last stream that leaves", async () => {
    const served = await serve({ mode: "outlives-adb" });
    const watching = stream(served);
    await watching.has(RECORDED.length);
    watching.tell(TAKE);
    watching.tell(touch("down", 100, 200));
    await served.phone.control(TOUCH_BYTES);

    watching.socket.close();

    expect(await served.phone.control(2 * TOUCH_BYTES)).toBe(hex(control.touch("down", 100, 200, 720, 1280), control.touch("up", 100, 200, 720, 1280)));
  });

  it("lift a finger at once when the screen turns under it, inside the new video, and drop the rest of that gesture", async () => {
    const served = await serve({ mode: "outlives-adb" });
    const watching = stream(served);
    await watching.has(RECORDED.length);
    watching.tell(TAKE);
    watching.tell(touch("down", 700, 1200));
    await served.phone.control(TOUCH_BYTES);

    await served.phone.send(videoSession(1280, 720));
    const turned = hex(control.touch("down", 700, 1200, 720, 1280), control.touch("up", 700, 719, 1280, 720));
    expect(await served.phone.control(2 * TOUCH_BYTES)).toBe(turned);

    watching.tell(touch("move", 690, 1190));
    watching.tell(touch("up", 690, 1190));
    watching.tell({ type: "key", key: "home" });
    const afterwards = turned + hex(control.key(KEYCODES.home));
    expect(await served.phone.control(2 * TOUCH_BYTES + KEY_BYTES)).toBe(afterwards);

    watching.socket.close();
    await watching.closed;
    await served.screen.closeAll();
    expect(await served.phone.control(0)).toBe(afterwards);
  });

  it("count input as the person still being there: a hold ends 5 minutes after the last of it, though a stream stays open", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);
    watching.tell(TAKE);
    watching.tell({ type: "key", key: "home" });
    await served.phone.control(KEY_BYTES);
    watching.tell({ type: "handBack" });
    await watching.said.has(3);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    watching.tell(TAKE);
    await watching.said.has(4);
    vi.advanceTimersByTime(4 * MINUTE);
    watching.tell(touch("down", 100, 200));
    await served.phone.control(KEY_BYTES + TOUCH_BYTES);
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(served.hold.held).toBe(true);
    vi.advanceTimersByTime(1);

    await watching.said.has(5);
    expect(watching.said.all).toEqual([FREE, HELD, FREE, HELD, FREE]);
    expect(await served.phone.control(KEY_BYTES + 2 * TOUCH_BYTES)).toBe(
      hex(control.key(KEYCODES.home), control.touch("down", 100, 200, 720, 1280), control.touch("up", 100, 200, 720, 1280)),
    );
    expect(watching.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("refuse a session without the admin scope", async () => {
    const served = await serve();
    const { headers } = served.paired(["client"]);

    expect(await get(served, "/api/usb-phones", headers)).toEqual({ status: 403, body: { error: "forbidden: this session lacks the admin scope" } });
    expect((await stream(served, { headers }).refused).status).toBe(403);
    expect(served.phone.calls()).toEqual([]);
  });

  it("refuse a stream from another origin", async () => {
    const served = await serve();
    const { headers } = served.paired();

    const foreign = await stream(served, { headers: { ...headers, origin: "https://attacker.invalid" } }).refused;
    expect(foreign).toEqual({ status: 403, body: JSON.stringify({ error: "forbidden: cross-origin request" }) });
    expect(served.phone.calls()).toEqual([]);

    const own = stream(served, { headers: { ...headers, origin: `http://${served.origin}` } });
    await own.has(1);
  });

  it("refuse a stream to a local process that shows neither an Origin nor the desktop app's token, though it may read the list", async () => {
    const served = await serve();

    const local = await stream(served, { headers: {} }).refused;
    expect(local).toEqual({ status: 403, body: JSON.stringify({ error: "forbidden: this change must come from the desktop app or a paired device" }) });
    expect(served.phone.calls()).toEqual([]);
    expect((await get(served, "/api/usb-phones")).status).toBe(200);
  });

  it.each([
    ["a serial that is not connected", "/api/usb-phones/OTHER/stream", 404, "That USB phone is not connected."],
    ["a phone that is not on USB", "/api/usb-phones/emulator-5554/stream", 404, "That USB phone is not connected."],
    ["a serial with a character no USB serial has", "/api/usb-phones/a:b/stream", 404, ""],
    ["a phone that has not allowed USB debugging", "/api/usb-phones/LOCKED/stream", 409, "Unlock the phone and accept Allow USB debugging"],
    ["a phone adb cannot reach", "/api/usb-phones/ASLEEP/stream", 409, "The Android device is offline"],
  ])("refuse a stream for %s", async (_what, path, status, error) => {
    const served = await serve();

    const refused = await stream(served, { path }).refused;
    expect(refused).toEqual({ status, body: error && JSON.stringify({ error }) });
    expect(served.phone.calls().filter((call) => call[0] === "-s")).toEqual([]);
  });

  it("want a GET, and an upgrade for the stream", async () => {
    const served = await serve();

    expect(await get(served, "/api/usb-phones", DESKTOP_APP, "POST")).toEqual({ status: 405, body: { error: "method not allowed" } });
    expect(await get(served, STREAM, DESKTOP_APP)).toEqual({ status: 426, body: { error: "WebSocket upgrade required" } });
  });

  it("close a stream with 4404 within 5 seconds of the flag going off", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);

    vi.advanceTimersByTime(5_000);
    await served.phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await watching.has(RECORDED.length + 1);

    served.flag.on = false;
    vi.advanceTimersByTime(4_999);
    await served.phone.send(videoFrame("delta", Buffer.from("delta 12")));
    await watching.has(RECORDED.length + 2);
    vi.advanceTimersByTime(1);
    expect(await watching.closed).toEqual({ code: 4404, reason: "This phone view is no longer available." });
  });

  it("end a hold, and close with 4404 the stream that sends anything, once the flag is off", async () => {
    const served = await serve();
    const watching = stream(served);
    watching.socket.once("open", () => watching.tell({ type: "take" }));
    await watching.said.has(2);
    expect(served.hold.held).toBe(true);

    served.flag.on = false;
    watching.tell({ type: "take" });
    expect(await watching.closed).toEqual({ code: 4404, reason: "This phone view is no longer available." });
    expect(served.hold.held).toBe(false);
    expect(watching.said.all).toEqual([FREE, HELD, FREE]);
  });

  it("close a stream with 4404 within 5 seconds of its sign-in ending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const served = await serve();
    const { headers, sessionId } = served.paired();
    const watching = stream(served, { headers });
    await watching.has(RECORDED.length);

    served.sessions.revoke(sessionId);
    vi.advanceTimersByTime(5_000);
    expect(await watching.closed).toEqual({ code: 4404, reason: "This phone view is no longer available." });
  });

  it("close a session's stream with 4404 at once when the session is revoked, and no other stream", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const served = await serve();
    served.sessions.onSessionRevoked((sessionId) => served.screen.closeForOwner(sessionId));
    const { headers, sessionId } = served.paired();
    const revoked = stream(served, { headers });
    const paired = stream(served, { headers: served.paired().headers });
    const desktopApp = stream(served);
    await Promise.all([revoked, paired, desktopApp].map((watching) => watching.has(RECORDED.length)));

    served.sessions.revoke(sessionId);
    expect(await revoked.closed).toEqual({ code: 4404, reason: "This phone view is no longer available." });

    await served.phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await Promise.all([paired, desktopApp].map((watching) => watching.has(RECORDED.length + 1)));
    expect(revoked.messages).toHaveLength(RECORDED.length);
  });

  it("refuse a stream whose sign-in ended while its phone was looked up, and send it no video", async () => {
    let duringLookup = () => {};
    const served: Fixture = await serve({
      adbPath: () => {
        duringLookup();
        return served.phone.adbPath;
      },
    });
    const { headers, sessionId } = served.paired();
    duringLookup = () => served.sessions.revoke(sessionId);
    const late = stream(served, { headers });

    expect(await Promise.race([late.refused, late.has(1).then(() => "received video")])).toEqual({ status: 401, body: JSON.stringify({ error: "Viewer access expired" }) });
    expect(served.watched.all).toEqual([]);
    expect(served.phone.calls().filter((call) => call[0] === "-s")).toEqual([]);
  });

  it("refuse a stream as they do with the flag off when it went off while the stream's phone was looked up", async () => {
    let duringLookup = () => {};
    const served: Fixture = await serve({
      adbPath: () => {
        duringLookup();
        return served.phone.adbPath;
      },
    });
    duringLookup = () => {
      served.flag.on = false;
    };
    const late = stream(served);

    const absent = { status: 404, body: "" };
    expect(await Promise.race([late.refused, late.has(1).then(() => "received video")])).toEqual(absent);
    expect(await stream(served).refused).toEqual(absent);
    expect(served.watched.all).toEqual([]);
    expect(served.phone.calls().filter((call) => call[0] === "-s")).toEqual([]);
    expect(served.serverFileAsks).toBe(0);
  });

  it("cut off a client that has answered no ping for 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const served = await serve();
    const silent = await silentStream(served);
    const gone = new Promise<void>((resolve) => silent.once("close", () => resolve()));
    const answering = stream(served);
    await answering.has(RECORDED.length);

    vi.advanceTimersByTime(15_000);
    await served.phone.send(videoFrame("delta", Buffer.from("delta 11")));
    await answering.has(RECORDED.length + 1);
    expect(silent.destroyed).toBe(false);

    vi.advanceTimersByTime(15_000);
    await gone;
    await served.phone.send(videoFrame("delta", Buffer.from("delta 12")));
    await answering.has(RECORDED.length + 2);
  });

  // Windows starts a script with a node shebang through node, so the bot box's check sees node's path, not the fake adb's.
  it.skipIf(process.platform === "win32")("close a stream with 1011 and the refusal's own words when the bot box will not let the server run adb", async () => {
    const served = await serve();
    distrustHomePrograms(served.phone.dir);
    const refusal = "adb is in a folder the bots can write, so the server does not run it outside the bot box.";

    expect(await stream(served).closed).toEqual({ code: 1011, reason: refusal });
    expect(await get(served, "/api/usb-phones")).toEqual({
      status: 200,
      body: { available: false, reasonCode: "adb-failed", message: refusal, devices: [] },
    });
    expect(served.phone.calls()).toEqual([]);
  });

  it("say so in the list, and close a stream with 1011, when the server has no adb", async () => {
    const served = await serve({ adbPath: () => null });
    const missing = "adb was not found on the server.";

    expect(await get(served, "/api/usb-phones")).toEqual({
      status: 200,
      body: { available: false, reasonCode: "adb-unavailable", message: missing, devices: [] },
    });
    expect(await stream(served).closed).toEqual({ code: 1011, reason: missing });
  });

  it("close a stream with 1011 and the reason when the phone's screen cannot be opened", async () => {
    const served = await serve();
    served.phone.become("exits");

    expect(await stream(served).closed).toEqual({ code: 1011, reason: "Could not open the phone's screen. scrcpy stopped on the phone before the screen was open." });
  });

  it("cut a close reason to the 123 bytes a close frame carries, between two characters", async () => {
    const served = await serve({ serverFile: () => Promise.reject(new Error("é".repeat(100))) });

    expect(await stream(served).closed).toEqual({ code: 1011, reason: "é".repeat(61) });
  });

  it.each([
    ["cannot be downloaded", () => new Response(null, { status: 404 }), "HTTP 404"],
    ["has another digest than the pinned one", () => new Response("tampered"), "wrong SHA-256"],
  ])("say why, and where to save a copy by hand, in the first 123 bytes of the reason when the scrcpy server file %s", async (_what, answer, cause) => {
    let fetching: Promise<string> | undefined;
    const served: Fixture = await serve({
      serverFile: () => (fetching = ensureScrcpyServer(served.home, { fetch: async () => answer() })),
    });

    const { code, reason } = await stream(served).closed;
    const message = await fetching?.then(() => "", (error: Error) => error.message) ?? "";
    const whyAndWhere = `Download failed (${cause}): save scrcpy-server ${SCRCPY_SERVER.version} as ${join(served.home, "scrcpy", `scrcpy-server-v${SCRCPY_SERVER.version}`)}`;
    expect(message.slice(0, whyAndWhere.length)).toBe(whyAndWhere);
    expect(code).toBe(1011);
    const sent = Buffer.from(reason);
    expect(sent).toEqual(Buffer.from(message).subarray(0, sent.length));
    // A UTF-8 character is at most 4 bytes, so a cut between two characters gives up at most 3.
    expect(sent.length).toBeGreaterThan(123 - 4);
    expect(sent.length).toBeLessThanOrEqual(123);
  });

  it("close every stream with 1012 when the server stops", async () => {
    const served = await serve();
    const watching = stream(served);
    await watching.has(RECORDED.length);

    await served.screen.closeAll();
    expect(await watching.closed).toEqual({ code: 1012, reason: "The server is stopping." });
    expect(served.phone.calls().at(-1)?.slice(2, 4)).toEqual(["shell", "rm"]);
  });
});
