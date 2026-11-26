import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { concat, fromB64u, utf8 } from "./bytes.ts";
import { credentialHash, keyId, psk } from "./credentials.ts";
import { HttpError } from "./http.ts";
import { dial, type E2EStream, type PhoneSession } from "./session.ts";
import { streamWebSocket, type StreamSocketClose, type StreamSocketOptions } from "./websocket.ts";

const SERVER = fileURLToPath(new URL("../../../companion/src/e2e/interop-server.ts", import.meta.url));

/** What a socket handed its page: whole messages and the one close. */
function listener() {
  const messages: (string | Uint8Array)[] = [];
  const closes: StreamSocketClose[] = [];
  return { messages, closes, onMessage: (data: string | Uint8Array) => void messages.push(data), onClose: (event: StreamSocketClose) => void closes.push(event) };
}

/** A stream the test plays the computer on: reply bytes pushed in by hand, the client's frames read back unmasked. */
function fakeComputer() {
  const written: Uint8Array[] = [];
  const state = { ended: false, reset: false };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream: E2EStream = {
    id: 1,
    ended: new Promise<void>(() => {}),
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    }),
    write: async (bytes) => {
      if (state.ended || state.reset) throw new Error("stream reset");
      written.push(Uint8Array.from(bytes));
    },
    end: () => void (state.ended = true),
    reset: () => {
      state.reset = true;
      try {
        source.error(new Error("stream reset"));
      } catch {
        /* already closed */
      }
    },
  };
  return {
    open: () => stream,
    state,
    written,
    push: (bytes: string | Uint8Array) => source.enqueue(typeof bytes === "string" ? utf8(bytes) : bytes),
    finish: () => source.close(),
    /** The client's frames after the upgrade request. */
    frames: () => written.slice(1).map(readClientFrame),
  };
}

type Fake = ReturnType<typeof fakeComputer>;

function serverFrame(op: number, payload: Uint8Array | string = new Uint8Array(0), { fin = true, mask = false, rsv = 0 } = {}): Uint8Array {
  const body = typeof payload === "string" ? utf8(payload) : payload;
  const size = body.length;
  const head = size < 126 ? [size] : size < 65_536 ? [126, size >> 8, size & 0xff] : [127, 0, 0, 0, 0, (size >>> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
  head[0] |= mask ? 0x80 : 0;
  return concat(Uint8Array.of((fin ? 0x80 : 0) | rsv | op, ...head), mask ? Uint8Array.of(0, 0, 0, 0) : new Uint8Array(0), body);
}

function readClientFrame(bytes: Uint8Array) {
  const fin = (bytes[0] & 0x80) !== 0;
  const op = bytes[0] & 0x0f;
  const masked = (bytes[1] & 0x80) !== 0;
  let length = bytes[1] & 0x7f;
  let at = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (length === 126) [length, at] = [view.getUint16(2), 4];
  else if (length === 127) [length, at] = [Number(view.getBigUint64(2)), 10];
  const mask = bytes.subarray(at, at + 4);
  const payload = bytes.slice(at + 4, at + 4 + length).map((byte, i) => byte ^ mask[i & 3]);
  expect(at + 4 + length).toBe(bytes.length);
  return { fin, op, masked, payload };
}

const closeCode = (payload: Uint8Array) => (payload[0] << 8) | payload[1];

/** The upgrade request the client wrote, once it is written. */
async function request(fake: Fake): Promise<{ text: string; key: string }> {
  await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0));
  const text = new TextDecoder().decode(fake.written[0]);
  return { text, key: /\r\nSec-WebSocket-Key: (\S+)\r\n/.exec(text)![1] };
}

const acceptFor = (key: string) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

async function switched(fake: Fake, options: Partial<StreamSocketOptions> = {}, extra = "") {
  const page = listener();
  const opening = streamWebSocket(fake.open, { path: "/ws", ...page, ...options });
  const { key } = await request(fake);
  fake.push(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n${extra}\r\n`);
  return { socket: await opening, page };
}

describe("streamWebSocket handshake", () => {
  it("sends an RFC 6455 upgrade and opens on a matching 101", async () => {
    const fake = fakeComputer();
    const page = listener();
    const opening = streamWebSocket(fake.open, { path: "/ws?x=1", headers: { authorization: "Bearer t" }, protocols: ["a", "b"], ...page });
    const { text, key } = await request(fake);
    expect(text).toMatch(/^GET \/ws\?x=1 HTTP\/1\.1\r\nHost: companion\r\nauthorization: Bearer t\r\n/);
    expect(text).toContain("\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n");
    expect(text).toContain("\r\nSec-WebSocket-Protocol: a, b\r\n");
    expect(text.endsWith("\r\n\r\n")).toBe(true);
    expect(atob(key)).toHaveLength(16);
    fake.push(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Protocol: b\r\n\r\n`);
    const socket = await opening;
    expect(socket.protocol).toBe("b");
    expect(socket.readyState).toBe("open");
    expect(fake.state).toEqual({ ended: false, reset: false });
  });

  it.each([
    ["a wrong Sec-WebSocket-Accept", (key: string) => `HTTP/1.1 101 x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key + "x")}\r\n\r\n`, /Sec-WebSocket-Accept/],
    ["a plain reply", () => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n", /answered 404/],
    ["a switch to something else", (key: string) => `HTTP/1.1 101 x\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`, /not to WebSocket/],
    ["an extension nobody offered", (key: string) => `HTTP/1.1 101 x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`, /extension/],
    ["a subprotocol nobody offered", (key: string) => `HTTP/1.1 101 x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Protocol: z\r\n\r\n`, /subprotocol "z"/],
  ])("refuses %s and resets the stream", async (_what, reply, message) => {
    const fake = fakeComputer();
    const opening = streamWebSocket(fake.open, { path: "/ws", ...listener() });
    fake.push(reply((await request(fake)).key));
    const error = await opening.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as Error).message).toMatch(message);
    expect(fake.state.reset).toBe(true);
  });

  it("refuses a caller's own upgrade headers and bad subprotocols before opening a stream", async () => {
    const open = vi.fn(() => fakeComputer().open());
    await expect(streamWebSocket(open, { path: "/ws", headers: { "Sec-WebSocket-Key": "x" }, ...listener() })).rejects.toThrow(TypeError);
    await expect(streamWebSocket(open, { path: "/ws", protocols: ["a b"], ...listener() })).rejects.toThrow(TypeError);
    await expect(streamWebSocket(open, { path: "/ws", protocols: ["a", "a"], ...listener() })).rejects.toThrow(TypeError);
    expect(open).not.toHaveBeenCalled();
  });

  it("resets the stream and rejects with the reason when aborted during the handshake", async () => {
    const fake = fakeComputer();
    const abort = new AbortController();
    const opening = streamWebSocket(fake.open, { path: "/ws", signal: abort.signal, ...listener() });
    await request(fake);
    abort.abort(new Error("gave up"));
    await expect(opening).rejects.toThrow("gave up");
    expect(fake.state.reset).toBe(true);
  });
});

describe("StreamWebSocket frames", () => {
  it("masks every client frame and uses the shortest length form", async () => {
    const fake = fakeComputer();
    const { socket } = await switched(fake);
    await socket.send("héllo");
    await socket.send(new Uint8Array(200).fill(7));
    await socket.send(new Uint8Array(70_000).fill(9));
    const frames = fake.frames();
    expect(frames.map(({ fin, op, masked }) => [fin, op, masked])).toEqual([
      [true, 1, true],
      [true, 2, true],
      [true, 2, true],
    ]);
    expect(new TextDecoder().decode(frames[0].payload)).toBe("héllo");
    expect(fake.written[2][1] & 0x7f).toBe(126);
    expect(fake.written[3][1] & 0x7f).toBe(127);
    expect(frames[2].payload.every((byte) => byte === 9)).toBe(true);
  });

  it("puts fragments back together, answers a ping in between and reads bytes that came with the 101", async () => {
    const fake = fakeComputer();
    const page = listener();
    const opening = streamWebSocket(fake.open, { path: "/ws", ...page });
    const { key } = await request(fake);
    const accept = utf8(`HTTP/1.1 101 x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`);
    fake.push(concat(accept, serverFrame(2, Uint8Array.of(1, 2, 3))));
    await opening;
    // "é" split across two fragments, with a ping between them.
    const text = utf8("café");
    fake.push(concat(serverFrame(1, text.subarray(0, 4), { fin: false }), serverFrame(9, "p?"), serverFrame(0, text.subarray(4))));
    await vi.waitFor(() => expect(page.messages).toHaveLength(2));
    expect(page.messages).toEqual([Uint8Array.of(1, 2, 3), "café"]);
    await vi.waitFor(() => expect(fake.frames()).toHaveLength(1));
    const [pong] = fake.frames();
    expect(pong.op).toBe(10);
    expect(new TextDecoder().decode(pong.payload)).toBe("p?");
  });

  it.each([
    ["invalid UTF-8 in a text message", serverFrame(1, Uint8Array.of(0xc3, 0x28)), 1007],
    ["a masked frame from the computer", serverFrame(2, "x", { mask: true }), 1002],
    ["reserved bits", serverFrame(2, "x", { rsv: 0x40 }), 1002],
    ["an unknown opcode", serverFrame(3, "x"), 1002],
    ["a fragmented ping", serverFrame(9, "x", { fin: false }), 1002],
    ["a continuation with no message", serverFrame(0, "x"), 1002],
    ["a message over maxMessage", serverFrame(2, new Uint8Array(11)), 1009],
    ["a close code that may not be sent", serverFrame(8, Uint8Array.of(0x03, 0xed)), 1002],
  ])("fails the socket on %s: close frame, then FIN, and 1006 for the page", async (_what, frame, code) => {
    const fake = fakeComputer();
    const { socket, page } = await switched(fake, { maxMessage: 10 });
    fake.push(frame);
    await vi.waitFor(() => expect(page.closes).toHaveLength(1));
    expect(page.closes[0]).toEqual({ code: 1006, reason: "", wasClean: false });
    expect(page.messages).toEqual([]);
    await vi.waitFor(() => expect(fake.state.ended).toBe(true));
    const frames = fake.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].op).toBe(8);
    expect(closeCode(frames[0].payload)).toBe(code);
    expect(socket.readyState).toBe("closed");
    await expect(socket.send("late")).rejects.toThrow(/closed/);
  });

  it("answers the computer's close with its code, then ends the stream", async () => {
    const fake = fakeComputer();
    const { socket, page } = await switched(fake);
    fake.push(serverFrame(8, concat(Uint8Array.of(0x03, 0xe9), utf8("going away"))));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1001, reason: "going away", wasClean: true }]));
    await vi.waitFor(() => expect(fake.state.ended).toBe(true));
    expect(fake.frames().map(({ op, payload }) => [op, closeCode(payload), payload.length])).toEqual([[8, 1001, 2]]);
    expect(socket.readyState).toBe("closed");
    expect(fake.state.reset).toBe(false);
  });

  it("reports 1005 for a close frame with no code", async () => {
    const fake = fakeComputer();
    const { page } = await switched(fake);
    fake.push(serverFrame(8));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1005, reason: "", wasClean: true }]));
    await vi.waitFor(() => expect(fake.frames().map(({ op, payload }) => [op, payload.length])).toEqual([[8, 0]]));
  });

  it("close() sends one close frame, refuses later sends and finishes on the computer's answer", async () => {
    const fake = fakeComputer();
    const { socket, page } = await switched(fake);
    socket.close(4000, "done");
    socket.close(1000);
    expect(socket.readyState).toBe("closing");
    await expect(socket.send("late")).rejects.toThrow(/closing/);
    await vi.waitFor(() => expect(fake.frames()).toHaveLength(1));
    const [frame] = fake.frames();
    expect([frame.op, closeCode(frame.payload), new TextDecoder().decode(frame.payload.subarray(2))]).toEqual([8, 4000, "done"]);
    expect(fake.state.ended).toBe(false);
    fake.push(serverFrame(8, Uint8Array.of(0x0f, 0xa0)));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 4000, reason: "", wasClean: true }]));
    await vi.waitFor(() => expect(fake.state.ended).toBe(true));
    expect(fake.frames()).toHaveLength(1);
  });

  it("close() refuses codes and reasons a browser refuses", async () => {
    const { socket } = await switched(fakeComputer());
    expect(() => socket.close(1001)).toThrow(TypeError);
    expect(() => socket.close(5000)).toThrow(TypeError);
    expect(() => socket.close(undefined, "why")).toThrow(TypeError);
    expect(() => socket.close(1000, "x".repeat(124))).toThrow(TypeError);
    expect(socket.readyState).toBe("open");
  });

  it("answers a ping that comes while waiting for the computer's close", async () => {
    const fake = fakeComputer();
    const { socket } = await switched(fake);
    socket.close(1000);
    fake.push(serverFrame(9, "p"));
    await vi.waitFor(() => expect(fake.frames().map(({ op, payload }) => [op, new TextDecoder().decode(op === 8 ? payload.subarray(2) : payload)])).toEqual([[8, ""], [10, "p"]]));
  });

  it("resets the stream and reports 1006 when the computer never answers close() in time", async () => {
    const fake = fakeComputer();
    const { socket, page } = await switched(fake, { closeTimeoutMs: 50 });
    socket.close(1000);
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]));
    expect(fake.state.reset).toBe(true);
  });

  /** Writes from now on wait until the stream is reset, as a session's do when the computer stops reading. */
  function holdWrites(fake: Fake, held: (bytes: Uint8Array) => boolean) {
    const stream = fake.open();
    const { write, reset } = stream;
    const waiting: ((error: Error) => void)[] = [];
    stream.write = (bytes) => (held(bytes) ? new Promise<void>((_, reject) => void waiting.push(reject)) : write(bytes));
    stream.reset = () => {
      reset();
      for (const reject of waiting.splice(0)) reject(new Error("stream reset"));
    };
    return waiting;
  }

  it("resets the stream and reports 1006 when its answer to the computer's close is not handed over in time", async () => {
    const fake = fakeComputer();
    const { page } = await switched(fake, { closeTimeoutMs: 50 });
    const waiting = holdWrites(fake, () => true);
    fake.push(serverFrame(8, Uint8Array.of(0x03, 0xe8)));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]));
    expect(fake.state.reset).toBe(true);
  });

  it("resets at once on a protocol error while waiting for the computer's close", async () => {
    const fake = fakeComputer();
    const { socket, page } = await switched(fake);
    socket.close(1000);
    fake.push(serverFrame(1, "x", { rsv: 4 }));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]));
    expect(fake.state).toMatchObject({ reset: true, ended: false });
  });

  it("resets the stream when the close frame for a protocol error is not handed over in time", async () => {
    const fake = fakeComputer();
    const { page } = await switched(fake, { closeTimeoutMs: 50 });
    holdWrites(fake, () => true);
    fake.push(serverFrame(1, "x", { rsv: 4 }));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]));
    await vi.waitFor(() => expect(fake.state.reset).toBe(true));
  });

  it("puts a message of 300,000 one-byte fragments back together, empty fragments between them, and an all-empty one", async () => {
    const fake = fakeComputer();
    const { page } = await switched(fake);
    const count = 300_000;
    const wire = new Uint8Array(count * 3 + 2 * 1000 + 2 + 2);
    let at = 0;
    const put = (frame: Uint8Array) => (wire.set(frame, at), (at += frame.length));
    for (let i = 0; i < count; i++) {
      put(serverFrame(i === 0 ? 2 : 0, Uint8Array.of(i % 251), { fin: i === count - 1 }));
      if (i === 1) for (let j = 0; j < 1000; j++) put(serverFrame(0, new Uint8Array(0), { fin: false }));
    }
    put(serverFrame(2, new Uint8Array(0), { fin: false }));
    put(serverFrame(0, new Uint8Array(0)));
    fake.push(wire.subarray(0, at));
    await vi.waitFor(() => expect(page.messages).toHaveLength(2), { timeout: 10_000 });
    expect(page.messages[0]).toEqual(Uint8Array.from({ length: count }, (_, i) => i % 251));
    expect(page.messages[1]).toEqual(new Uint8Array(0));
    expect(page.closes).toEqual([]);
  });

  it("reports a clean close only once its close answer is handed to the session", async () => {
    const fake = fakeComputer();
    const { page } = await switched(fake);
    const stream = fake.open();
    const write = stream.write;
    let fail!: (error: Error) => void;
    stream.write = (bytes) => (bytes.length === 2 + 4 + 2 ? new Promise<void>((_, reject) => (fail = reject)) : write(bytes));
    fake.push(serverFrame(8, Uint8Array.of(0x03, 0xe8)));
    await vi.waitFor(() => expect(fail).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.closes).toEqual([]);
    fail(new Error("stream reset"));
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]));
    expect(fake.state.reset).toBe(true);
  });

  it("checks the chosen subprotocol against the list it sent, even if the caller's array changes meanwhile", async () => {
    const fake = fakeComputer();
    const protocols = ["a"];
    const opening = streamWebSocket(fake.open, { path: "/ws", ...listener(), protocols, headers: { "X-Label": "é" } });
    const { key } = await request(fake);
    expect([...fake.written[0]]).toContain(0xe9);
    protocols[0] = "b";
    fake.push(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Protocol: b\r\n\r\n`);
    await expect(opening).rejects.toThrow("was not offered");
  });

  it("reports 1006 and resets when the stream ends without a closing handshake", async () => {
    const fake = fakeComputer();
    const { socket, page } = await switched(fake);
    fake.push(serverFrame(2, Uint8Array.of(1)).subarray(0, 2));
    fake.finish();
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1006, reason: "", wasClean: false }]));
    expect(fake.state.reset).toBe(true);
    expect(socket.readyState).toBe("closed");
  });
});

describe("streamWebSocket over a real session (interop computer)", () => {
  let child: ChildProcess;
  let session: PhoneSession;

  beforeAll(async () => {
    child = spawn(process.execPath, [SERVER, "--port", "0", "--exit-with-stdin"], { stdio: ["pipe", "pipe", "ignore"] });
    const ready = await new Promise<{ direct: string; k: string; deviceToken: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("interop server did not say ready in 10 s")), 10_000);
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n").slice(0, -1).find((candidate) => candidate.startsWith("{"));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`interop server exited ${code}`)));
    });
    const remoteStatic = fromB64u(ready.k)!;
    const key = await psk(await credentialHash(ready.deviceToken), await keyId(remoteStatic));
    session = await dial({ url: ready.direct, remoteStatic, psk: key, app: "web-test/1" });
  });

  afterAll(() => {
    session?.close(1000);
    child?.kill("SIGTERM");
  });

  it("echoes messages in order, a large one included, and closes cleanly", async () => {
    const page = listener();
    const socket = await streamWebSocket(() => session.open(), { path: "/ws", ...page });
    const big = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
    await socket.send("hello");
    await socket.send(Uint8Array.of(0, 1, 2));
    await socket.send(big);
    await vi.waitFor(() => expect(page.messages).toHaveLength(3), { timeout: 10_000 });
    // The interop origin echoes every message as binary.
    expect(new TextDecoder().decode(page.messages[0] as Uint8Array)).toBe("hello");
    expect(page.messages[1]).toEqual(Uint8Array.of(0, 1, 2));
    expect((page.messages[2] as Uint8Array).length).toBe(big.length);
    expect(page.messages[2]).toEqual(big);
    socket.close(1000);
    await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1000, reason: "", wasClean: true }]));
  });

  it("refuses a path the origin does not upgrade", async () => {
    await expect(streamWebSocket(() => session.open(), { path: "/nope", ...listener() })).rejects.toThrow(HttpError);
  });

  it("keeps the session usable for other sockets after one closes", async () => {
    for (let round = 0; round < 3; round++) {
      const page = listener();
      const socket = await streamWebSocket(() => session.open(), { path: "/ws", ...page });
      await socket.send(`round ${round}`);
      await vi.waitFor(() => expect(page.messages).toHaveLength(1));
      socket.close();
      await vi.waitFor(() => expect(page.closes).toEqual([{ code: 1005, reason: "", wasClean: true }]));
    }
  });
});
