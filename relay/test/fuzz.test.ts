import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { connect, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import { Close, SUBPROTOCOL } from "../src/wire.ts";
import { Client, fakeHost, freshIp, mintToken, phoneHello, sleep, splicedPair, startTestRelay, type TestRelay } from "./helpers.ts";

/** How long the random campaign runs: CI gives 20 s to a pull request and 10 min to the nightly run. */
const FUZZ_MS = Number(process.env.RELAY_FUZZ_MS) || 3_000;
const SLOW_SOCKETS = FUZZ_MS >= 60_000 ? 3_000 : 200;
/** What a socket may be closed with when its first message is anything but a valid one. */
const REFUSED = new Set([Close.Malformed, Close.TokenInvalid, Close.NotFound, 1002, 1007, 1009]);
const PATHS = ["/v1/host", "/v1/host/data", "/v1/phone"];

let t: TestRelay;

before(async () => {
  t = await startTestRelay();
});

after(async () => {
  await t.stop();
});

const pick = <T>(items: readonly T[]): T => items[randomInt(items.length)]!;

function mutate(text: string): Buffer {
  const bytes = Buffer.from(text);
  switch (randomInt(6)) {
    case 0: {
      const at = randomInt(bytes.length);
      bytes[at]! ^= 1 << randomInt(8);
      return bytes;
    }
    case 1: {
      const at = randomInt(bytes.length);
      return Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + 1 + randomInt(4))]);
    }
    case 2: {
      const at = randomInt(bytes.length);
      return Buffer.concat([bytes.subarray(0, at), randomBytes(1 + randomInt(8)), bytes.subarray(at)]);
    }
    case 3:
      return bytes.subarray(0, randomInt(bytes.length));
    case 4:
      return Buffer.concat([bytes, randomBytes(1 + randomInt(16))]);
    default:
      return Buffer.from(text.replace(/"[a-z]+":/, `"${pick(["t", "v", "__proto__", "constructor", "token", "set"])}":`));
  }
}

function strangeJson(): string {
  return pick([
    () => `${"[".repeat(1_500)}${"]".repeat(1_500)}`,
    () => JSON.stringify({ t: pick(["auth", "phone", "data", "admit"]), v: pick([1, "1", 1.0000001, -1, 2 ** 53, null, [1], { v: 1 }]) }),
    () => JSON.stringify({ t: "phone", v: 1, hid: pick(["", "=", "A".repeat(22), "A".repeat(23), "\u0000".repeat(22)]), adm: "A".repeat(43) }),
    () => JSON.stringify({ t: "admit", set: Array.from({ length: randomInt(40) }, () => randomBytes(32).toString("base64url")) }),
    () => '{"t":"phone","t":"auth","v":1,"token":"x"}',
    () => JSON.stringify({ __proto__: { t: "auth" }, constructor: { prototype: { v: 1 } } }),
    () => `{"t":"auth","v":1,"token":"${"\\u0041".repeat(600)}"}`,
    () => JSON.stringify({ t: "data", v: 1, sid: randomBytes(16).toString("base64url"), token: mintToken(t.key).replace(/.$/, "A") }),
  ])();
}

/** One random socket: a first message that is never valid, then (sometimes) more. Returns how the relay closed it. */
async function fuzzOne(): Promise<number> {
  const client = await Client.open(t.url, pick(PATHS));
  const valid = pick([
    JSON.stringify({ t: "auth", v: 1, token: mintToken(t.key, { exp: 1 }) }),
    JSON.stringify({ t: "phone", v: 1, hid: randomBytes(16).toString("base64url"), adm: randomBytes(32).toString("base64url") }),
    JSON.stringify({ t: "data", v: 1, sid: randomBytes(16).toString("base64url"), token: "x.y" }),
  ]);
  const sends = 1 + randomInt(3);
  for (let i = 0; i < sends && client.ws.readyState === WebSocket.OPEN; i++) {
    switch (randomInt(6)) {
      case 0:
        client.sendBinary(randomBytes(randomInt(5_000)));
        break;
      case 1:
        client.ws.send(randomBytes(1 + randomInt(200)), { binary: false });
        break;
      case 2:
        client.ws.send(mutate(valid), { binary: false });
        break;
      case 3:
        client.send(strangeJson());
        break;
      case 4:
        client.ws.send(randomBytes(4_097 + randomInt(65_000)), { binary: randomInt(2) === 0 });
        break;
      default:
        client.ws.send(randomBytes(70_001 + randomInt(100_000)), { binary: randomInt(2) === 0 });
    }
  }
  const { code } = await client.closedWithin(t.relay.ctx.limits.authDeadlineMs + 3_000);
  return code;
}

describe("pre-auth fuzzing", () => {
  test(`random first messages on every path for ${FUZZ_MS} ms: each socket is refused with a protocol close code`, async () => {
    const seen = new Map<number, number>();
    const stop = performance.now() + FUZZ_MS;
    let runs = 0;
    while (performance.now() < stop) {
      const codes = await Promise.all(Array.from({ length: 16 }, () => fuzzOne()));
      for (const code of codes) {
        seen.set(code, (seen.get(code) ?? 0) + 1);
        assert.ok(REFUSED.has(code as never), `closed with ${code}`);
      }
      runs += codes.length;
    }
    assert.ok(runs > 0);
    for (const code of [Close.Malformed, 1009]) assert.ok(seen.has(code), `never saw ${code} in ${JSON.stringify([...seen])}`);
  });

  test("the first message may be 4,096 bytes and not one more, even when it is otherwise valid", async () => {
    const sized = (bytes: number) => {
      const message = { t: "auth", v: 1, token: mintToken(t.key), pad: "" };
      message.pad = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(message)));
      return JSON.stringify(message);
    };
    const fits = await Client.open(t.url, "/v1/host");
    fits.send(sized(4_096));
    assert.equal((await fits.json()).t, "hello");
    fits.ws.close();
    const over = await Client.open(t.url, "/v1/host");
    over.send(sized(4_097));
    assert.equal(await over.closeCode(), Close.Malformed);
  });

  test("the expected code for each kind of bad first frame", async () => {
    const cases: Array<[string, (client: Client) => void, number]> = [
      ["binary", (c) => c.sendBinary(Buffer.from("{}")), Close.Malformed],
      ["invalid UTF-8 text", (c) => c.ws.send(Buffer.from([0x7b, 0xff, 0x7d]), { binary: false }), 1007],
      ["4,097 bytes of text", (c) => c.send(`"${"x".repeat(4_095)}"`), Close.Malformed],
      ["70,001 bytes", (c) => c.sendBinary(Buffer.alloc(70_001)), 1009],
      ["deep nesting", (c) => c.send(`${"[".repeat(2_000)}${"]".repeat(2_000)}`), Close.Malformed],
      ["two messages", (c) => (c.send("{}"), c.send("{}")), Close.Malformed],
    ];
    for (const [name, send, code] of cases) {
      const client = await Client.open(t.url, "/v1/phone");
      send(client);
      assert.equal(await client.closeCode(), code, name);
    }
  });
});

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function connected(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(t.relay.port, "127.0.0.1");
    socket.on("error", () => {});
    // A paused socket never reads the server's FIN, so it would never emit close.
    socket.resume();
    socket.once("connect", () => resolve(socket));
    socket.once("close", () => reject(new Error("could not connect")));
  });
}

/** Runs `make` `count` times, `batch` at a time: macOS caps a listener's accept queue at kern.ipc.somaxconn (128). */
async function inBatches<T>(count: number, make: () => Promise<T>, batch = 50): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < count; start += batch) out.push(...(await Promise.all(Array.from({ length: Math.min(batch, count - start) }, make))));
  return out;
}

/** A TCP socket past the WebSocket upgrade, for frames no WebSocket library would send. */
async function rawUpgrade(path = "/v1/phone"): Promise<Socket> {
  const socket = await connected();
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\nX-Forwarded-For: ${freshIp()}\r\n\r\n`,
  );
  const expected = createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
  const head = await new Promise<string>((resolve, reject) => {
    setTimeout(() => reject(new Error("no upgrade answer")), 10_000).unref();
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (text.includes("\r\n\r\n")) {
        socket.off("data", onData);
        resolve(text);
      }
    };
    socket.on("data", onData);
  });
  assert.ok(head.startsWith("HTTP/1.1 101") && head.includes(expected), head);
  return socket;
}

interface FrameOptions {
  fin?: boolean;
  rsv?: number;
  masked?: boolean;
  length?: bigint;
}

function frame(opcode: number, payload: Buffer, { fin = true, rsv = 0, masked = true, length }: FrameOptions = {}): Buffer {
  const size = length ?? BigInt(payload.length);
  const head = [(fin ? 0x80 : 0) | (rsv << 4) | opcode];
  const mask = masked ? 0x80 : 0;
  let extended = Buffer.alloc(0);
  if (size < 126n) head.push(mask | Number(size));
  else if (size < 65_536n) {
    head.push(mask | 126);
    extended = Buffer.alloc(2);
    extended.writeUInt16BE(Number(size));
  } else {
    head.push(mask | 127);
    extended = Buffer.alloc(8);
    extended.writeBigUInt64BE(size);
  }
  const key = masked ? randomBytes(4) : Buffer.alloc(0);
  const body = Buffer.from(payload);
  if (masked) for (let i = 0; i < body.length; i++) body[i]! ^= key[i % 4]!;
  return Buffer.concat([Buffer.from(head), extended, key, body]);
}

/** The close code in the first close frame the relay sends, or 0 if the connection ends without one. */
function closeCodeOf(socket: Socket, timeoutMs = 9_000): Promise<number> {
  return new Promise((resolve) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => finish(-1), timeoutMs);
    const finish = (code: number) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(code);
    };
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes[0] === 0x88) finish(bytes.readUInt16BE(2));
    });
    socket.on("close", () => finish(0));
    socket.on("error", () => {});
  });
}

describe("malformed frames before auth", () => {
  const cases: Array<[string, Buffer, number]> = [
    ["an unmasked client frame", frame(0x1, Buffer.from("{}"), { masked: false }), 1002],
    ["RSV1 set with no extension", frame(0x1, Buffer.from("{}"), { rsv: 4 }), 1002],
    ["a reserved opcode", frame(0x3, Buffer.from("x")), 1002],
    ["a fragmented ping", frame(0x9, Buffer.from("x"), { fin: false }), 1002],
    ["a ping over 125 bytes", frame(0x9, Buffer.alloc(126)), 1002],
    ["a continuation with nothing to continue", frame(0x0, Buffer.from("x")), 1002],
    ["a length over maxPayload, with no body sent", frame(0x2, Buffer.alloc(0), { length: 70_001n }), 1009],
    ["a 64-bit length with the top bit set", frame(0x2, Buffer.alloc(0), { length: 1n << 63n }), 1009],
    ["fragments adding up past maxPayload", Buffer.concat([frame(0x2, Buffer.alloc(40_000), { fin: false }), frame(0x0, Buffer.alloc(40_000))]), 1009],
  ];
  for (const [name, bytes, code] of cases) {
    test(name, async () => {
      const socket = await rawUpgrade();
      socket.write(bytes);
      assert.equal(await closeCodeOf(socket), code);
    });
  }

  test("a frame that never finishes arriving is cut at the auth deadline", async () => {
    const socket = await rawUpgrade();
    socket.write(frame(0x1, Buffer.alloc(1_000)).subarray(0, 20));
    assert.equal(await closeCodeOf(socket), Close.Malformed);
  });

  test("bytes that are not HTTP get a 400 and nothing else", async () => {
    const socket = connect(t.relay.port, "127.0.0.1");
    socket.write(randomBytes(512));
    const reply = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString("latin1")));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    assert.ok(reply === "" || reply.startsWith("HTTP/1.1 400"), reply.slice(0, 40));
  });
});

describe(`${SLOW_SOCKETS} slow sockets`, () => {
  test("upgraded sockets that say nothing, half-sent headers and half-sent frames are all gone within the deadlines", async () => {
    const opening = performance.now();
    const silent = await inBatches(SLOW_SOCKETS, () => Client.open(t.url, pick(PATHS)));
    const halfHeaders = await inBatches(Math.min(SLOW_SOCKETS, 500), async () => {
      const socket = await connected();
      const ended = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 15_000);
        socket.once("close", () => (clearTimeout(timer), resolve(true)));
      });
      socket.write("GET /v1/phone HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\n");
      return { ended };
    });
    const halfFrames = await inBatches(Math.min(SLOW_SOCKETS, 500), async () => {
      const socket = await rawUpgrade();
      const code = closeCodeOf(socket, 15_000);
      socket.write(frame(0x1, Buffer.alloc(2_000)).subarray(0, 100));
      return { code };
    });
    const [silentCodes, frameCodes, headerEnds] = await Promise.all([
      Promise.all(silent.map((client) => client.closeCode(15_000))),
      Promise.all(halfFrames.map(({ code }) => code)),
      Promise.all(halfHeaders.map(({ ended }) => ended)),
    ]);
    assert.ok(silentCodes.every((code) => code === Close.Malformed), JSON.stringify([...new Set(silentCodes)]));
    assert.ok(frameCodes.every((code) => code === Close.Malformed), JSON.stringify([...new Set(frameCodes)]));
    assert.ok(headerEnds.every(Boolean), "a half-sent request outlived the header deadline");
    assert.ok(performance.now() - opening < 15_000, "every slow socket was opened before the first deadline and gone soon after it");
    for (let i = 0; i < 50 && t.relay.sockets().size > 0; i++) await sleep(100);
    assert.equal(t.relay.sockets().size, 0);
  });
});

describe("after the fuzzing", () => {
  test("nothing is left behind and a real session still works", async () => {
    for (let i = 0; i < 50 && t.relay.sockets().size > 0; i++) await sleep(100);
    assert.equal(t.relay.sockets().size, 0);
    assert.equal(t.relay.ctx.hosts.size, 0);
    const { phone, data, host } = await splicedPair(t.url, t.key);
    phone.sendBinary(Buffer.from("alive"));
    assert.equal((await data.next()).data.toString(), "alive");
    const other = await fakeHost(t.url, t.key);
    const stranger = await phoneHello(t.url, other.hidText, randomBytes(32));
    assert.equal(await stranger.closeCode(), Close.NotFound);
    for (const client of [phone, data, host.control, other.control]) client.ws.close();
    assert.ok(process.memoryUsage().heapUsed < 512 * 1024 * 1024);
  });
});
