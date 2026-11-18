import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { credentialHash, fromB64u, keyId, psk } from "../../src/e2e/credentials.ts";
import { NoiseError, TRANSPORT_DIRECT, TRANSPORT_RELAY, type TransportByte } from "../../src/e2e/noise.ts";
import { dial } from "../../src/e2e/phone.ts";
import { SessionClosed, type E2ESession } from "../../src/e2e/session.ts";

const SERVER = fileURLToPath(new URL("../../src/e2e/interop-server.ts", import.meta.url));

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
  child = spawn(process.execPath, [SERVER, "--port", "0", "--ping-interval-ms", "200"], { stdio: ["pipe", "pipe", "ignore"] });
  ready = await new Promise<Ready>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line && out.includes("\n")) resolve(JSON.parse(line) as Ready);
    });
    child.once("exit", (code) => reject(new Error(`interop server exited ${code}`)));
  });
});

afterAll(() => {
  child?.kill("SIGTERM");
});

const pskFor = (token: string) => psk(credentialHash(token), keyId(fromB64u(ready.k)!));

function connect(url = ready.direct, token = ready.deviceToken, transportByte: TransportByte = TRANSPORT_DIRECT) {
  return dial({ url, transportByte, remoteStatic: fromB64u(ready.k)!, psk: pskFor(token), app: "test/1", pingIntervalMs: 200, pingTimeoutMs: 1_000 });
}

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function http(session: E2ESession<never>, method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { method, path, host: "companion", headers: { ...headers, ...(body ? { "Content-Length": String(body.length) } : {}) }, createConnection: () => session.openStream() },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const pattern = (start: number, length: number) => Buffer.from(Array.from({ length }, (_, index) => (start + index) % 251));

describe("a session with the interop server", () => {
  it("carries requests on several streams at once", async () => {
    const session = await connect();
    const health = await http(session, "GET", "/api/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString())).toEqual({ ok: true });
    const replies = await Promise.all([1, 2, 3].map(() => http(session, "GET", "/bytes?n=1000000")));
    for (const reply of replies) expect(reply.body.equals(pattern(0, 1_000_000))).toBe(true);
    session.shutdown();
  });

  it("streams a 4 MiB event and keeps the session alive through idle pings", async () => {
    const session = await connect();
    const reply = await http(session, "GET", "/sse?events=1&size=4194304");
    expect(reply.body.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(reply.body.toString("latin1").endsWith("event: end\ndata: {}\n\n")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(session.state).toBe("open");
    expect((await http(session, "GET", "/api/health")).status).toBe(200);
    session.shutdown();
  });

  it("uploads 25 MiB intact", async () => {
    const session = await connect();
    const body = randomBytes(25 * 1024 * 1024);
    const reply = await http(session, "POST", "/upload", body);
    expect(JSON.parse(reply.body.toString())).toEqual({ bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    session.shutdown();
  }, 60_000);

  it("honours Range", async () => {
    const session = await connect();
    const reply = await http(session, "GET", "/bytes?n=1000", undefined, { Range: "bytes=10-19" });
    expect(reply.status).toBe(206);
    expect(reply.headers["content-range"]).toBe("bytes 10-19/1000");
    expect(reply.body.equals(pattern(10, 10))).toBe(true);
    session.shutdown();
  });

  it("resets one stream mid-response and keeps the rest of the session", async () => {
    const session = await connect();
    await new Promise<void>((resolve) => {
      const req = request({ path: "/hang", host: "companion", createConnection: () => session.openStream() }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.activeStreams).toBe(0);
    expect((await http(session, "GET", "/api/health")).status).toBe(200);
    session.shutdown();
  });

  it("carries a WebSocket upgrade inside a stream", async () => {
    const session = await connect();
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const req = request({
        path: "/ws",
        host: "companion",
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") },
        createConnection: () => session.openStream(),
      });
      req.on("upgrade", (_res, upgraded: Duplex) => resolve(upgraded));
      req.on("error", reject);
      req.end();
    });
    const mask = randomBytes(4);
    const text = Buffer.from("hello viewer");
    const masked = Buffer.from(text.map((byte, index) => byte ^ mask[index % 4]));
    socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | text.length]), mask, masked]));
    const echoed = await new Promise<Buffer>((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk)));
    expect(echoed.subarray(2).toString()).toBe("hello viewer");
    socket.destroy();
    session.shutdown();
  });

  it("pairs with the pairing token's psk, and uses the relay prologue when told to", async () => {
    (await connect(ready.direct, ready.pairingToken)).shutdown();
    (await connect(ready.relayTransport, ready.deviceToken, TRANSPORT_RELAY)).shutdown();
  });

  it("is refused with 4001 for an unknown token or the wrong transport", async () => {
    await expect(connect(ready.direct, "omb_not_paired")).rejects.toEqual(new SessionClosed(4001));
    await expect(connect(ready.relayTransport, ready.deviceToken, TRANSPORT_DIRECT)).rejects.toEqual(new SessionClosed(4001));
  });

  it("hard-stops when the computer holds a different key", async () => {
    await expect(connect(ready.wrongKey)).rejects.toBeInstanceOf(NoiseError);
  });
});
