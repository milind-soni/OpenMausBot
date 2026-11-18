import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeFrame, encodeFrame, FLAG, OPEN_WINDOW_DELTA, TYPE } from "../../../companion/src/e2e/yamux.ts";
import { concat, fromB64u, utf8, type Bytes } from "./bytes.ts";
import { credentialHash, keyId, psk } from "./credentials.ts";
import { encodePayload1, newConn, phoneHello, TRANSPORT_DIRECT, TRANSPORT_RELAY, type SessionKeys, type TransportByte } from "./noise.ts";

const SERVER = fileURLToPath(new URL("../../../companion/src/e2e/interop-server.ts", import.meta.url));
const BOUND_MS = 10_000;

interface Ready {
  direct: string;
  relayTransport: string;
  wrongKey: string;
  k: string;
  deviceToken: string;
  pairingToken: string;
}

let child: ChildProcess;
let ready: Ready;

beforeAll(async () => {
  child = spawn(process.execPath, [SERVER, "--port", "0", "--exit-with-stdin"], { stdio: ["pipe", "pipe", "ignore"] });
  ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("interop server did not say ready in 10 s")), BOUND_MS);
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").slice(0, -1).find((candidate) => candidate.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Ready);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`interop server exited ${code}`)));
  });
});

afterAll(() => {
  child?.kill("SIGTERM");
});

/** A WebSocket's binary messages as a queue, each wait bounded. */
function open(url: string) {
  const socket = new WebSocket(url, "omb-e2e.v1");
  socket.binaryType = "arraybuffer";
  const queue: Bytes[] = [];
  const waiting: Array<{ resolve: (message: Bytes) => void; reject: (error: Error) => void }> = [];
  let closed: number | null = null;
  const closeWaiters: Array<(code: number) => void> = [];
  socket.addEventListener("message", (event) => {
    const message = new Uint8Array(event.data as ArrayBuffer);
    const next = waiting.shift();
    if (next) next.resolve(message);
    else queue.push(message);
  });
  socket.addEventListener("close", (event) => {
    closed = event.code;
    for (const waiter of closeWaiters.splice(0)) waiter(event.code);
    for (const reader of waiting.splice(0)) reader.reject(new Error(`socket closed with ${event.code}`));
  });
  const bounded = <T>(what: string, start: (resolve: (value: T) => void, reject: (error: Error) => void) => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no ${what} in 10 s`)), BOUND_MS);
      start(resolve, reject);
    }).finally(() => clearTimeout(timer));
  };
  return {
    opened: bounded<void>("open", (resolve) => socket.addEventListener("open", () => resolve())),
    send: (bytes: Bytes) => socket.send(bytes),
    next: () =>
      bounded<Bytes>("message", (resolve, reject) => {
        if (queue.length) resolve(queue.shift()!);
        else if (closed !== null) reject(new Error(`socket closed with ${closed}`));
        else waiting.push({ resolve, reject });
      }),
    closedWith: () => bounded<number>("close", (resolve) => (closed !== null ? resolve(closed) : closeWaiters.push(resolve))),
    close: () => socket.close(),
  };
}

async function handshake(url: string, token: string, transport: TransportByte) {
  const remoteStatic = fromB64u(ready.k)!;
  const hello = await phoneHello({ remoteStatic, psk: await psk(await credentialHash(token), await keyId(remoteStatic)), transport }, encodePayload1(newConn(), "web-test/1"));
  const ws = open(url);
  await ws.opened;
  ws.send(hello.message1);
  return { ws, finish: async () => hello.finish(await ws.next()) };
}

/** One HTTP request on stream 1, read until the origin closes the stream. */
async function get(ws: ReturnType<typeof open>, keys: SessionKeys, path: string): Promise<string> {
  const request = utf8(`GET ${path} HTTP/1.1\r\nHost: companion\r\nConnection: close\r\n\r\n`);
  const sealed = await Promise.all([
    keys.send.seal(new Uint8Array(encodeFrame({ type: TYPE.windowUpdate, flags: FLAG.syn, streamId: 1, length: OPEN_WINDOW_DELTA }))),
    keys.send.seal(new Uint8Array(encodeFrame({ type: TYPE.data, flags: 0, streamId: 1, length: request.length, data: request }))),
  ]);
  for (const record of sealed) ws.send(record);
  const body: Uint8Array[] = [];
  for (;;) {
    const frame = decodeFrame(await keys.receive.open(await ws.next()));
    if (frame.streamId !== 1) continue;
    if (frame.type === TYPE.data && frame.data) body.push(frame.data);
    if (frame.flags & FLAG.rst) throw new Error("stream 1 was reset");
    if (frame.flags & FLAG.fin) return new TextDecoder().decode(concat(...body));
  }
}

describe("the browser phone side against the Node computer", () => {
  it.each([
    ["direct, device token", () => ready.direct, () => ready.deviceToken, TRANSPORT_DIRECT],
    ["relay prologue, pairing token", () => ready.relayTransport, () => ready.pairingToken, TRANSPORT_RELAY],
  ] as const)("%s: handshakes and carries a request both ways", async (_name, url, token, transport) => {
    const { ws, finish } = await handshake(url(), token(), transport);
    const keys = await finish();
    const reply = await get(ws, keys, "/api/health");
    expect(reply.startsWith("HTTP/1.1 200")).toBe(true);
    expect(reply).toContain('{"ok":true}');
    ws.close();
  });

  it("is refused with 4001 when the token is not one the computer knows", async () => {
    const { ws } = await handshake(ready.direct, "not-a-token-the-computer-knows", TRANSPORT_DIRECT);
    expect(await ws.closedWith()).toBe(4001);
    await expect(ws.next()).rejects.toThrow("socket closed with 4001");
  });

  it("is refused when the prologue says relay but the route is direct", async () => {
    const { ws } = await handshake(ready.direct, ready.deviceToken, TRANSPORT_RELAY);
    expect(await ws.closedWith()).toBe(4001);
    await expect(ws.next()).rejects.toThrow("socket closed with 4001");
  });

  it("stops hard on a message 2 from a party without the key", async () => {
    const { ws, finish } = await handshake(ready.wrongKey, ready.deviceToken, TRANSPORT_DIRECT);
    await expect(finish()).rejects.toThrow("e2e: aead");
    ws.close();
  });
});
