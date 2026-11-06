// A computer for other implementations to test against: `node companion/src/e2e/interop-server.ts [--port N]`.
// It holds the vector transport key and accepts the vector device and pairing tokens, so a client needs only
// vectors/v1.json. No dependencies: it runs from a plain checkout with Node 24 or later.
//
// Prints one JSON line when ready. Routes:
//   /v1/e2e                  direct transport (0x02), the normal case
//   /test/relay-transport    the relay prologue (0x01) without a relay
//   /test/wrong-key          a key swap: any message 1 gets a well-formed message 2 that can't verify (a hard stop)
// Origin paths, over any stream:
//   GET  /api/health                     {"ok":true}
//   POST /upload                         {"bytes":N,"sha256":"<hex>"} of the body
//   POST /echo                           the body back, streamed
//   GET  /bytes?n=N                      N bytes, byte i = i % 251; one Range is honoured
//   GET  /sse?events=M&size=S&gapMs=G    M events of S bytes each, a keepalive comment between, then `event: end`
//   GET  /wait?ms=N                      answers after N ms
//   GET  /hang                           headers and one event, then nothing
//   GET  /ws (Upgrade: websocket)        echoes every message
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { b64u, credentialHash, keyId, psk } from "./credentials.ts";
import { generateKeyPair, keyPairFromPrivate, MAX_RECORD_BYTES, TAG_BYTES, TRANSPORT_DIRECT, TRANSPORT_RELAY, type TransportByte } from "./noise.ts";
import { E2ESession } from "./session.ts";
import { acceptWebSocket } from "./ws-server.ts";

const vectors = JSON.parse(readFileSync(new URL("./vectors/v1.json", import.meta.url), "utf8")) as {
  inputs: { transportPrivate: string; deviceToken: string; pairingToken: string };
};

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const T = keyPairFromPrivate(Buffer.from(vectors.inputs.transportPrivate, "hex"));
const tokens = { device: vectors.inputs.deviceToken, pairing: vectors.inputs.pairingToken };
const candidates = Object.entries(tokens).map(([id, token]) => ({ id, psk: psk(credentialHash(token), keyId(T.publicKey)) }));

const pattern = (start: number, length: number): Buffer => {
  const out = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) out[index] = (start + index) % 251;
  return out;
};

function bytesRoute(req: IncomingMessage, res: ServerResponse, total: number): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = total - 1;
  if (req.headers.range) {
    if (!range || Number(range[1]) >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
  }
  const length = end - start + 1;
  res.writeHead(req.headers.range ? 206 : 200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": length,
    "Accept-Ranges": "bytes",
    ...(req.headers.range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
  });
  let offset = start;
  const pump = () => {
    while (offset <= end) {
      const size = Math.min(64 * 1024, end - offset + 1);
      const more = res.write(pattern(offset, size));
      offset += size;
      if (!more) return void res.once("drain", pump);
    }
    res.end();
  };
  pump();
}

function sseRoute(res: ServerResponse, events: number, size: number, gapMs: number): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let sent = 0;
  const next = () => {
    if (res.destroyed) return;
    if (sent === events) return void res.end("event: end\ndata: {}\n\n");
    const data = Buffer.alloc(size, 0x61 + (sent % 26)).toString("latin1");
    sent += 1;
    const more = res.write(`id: ${sent}\ndata: ${data}\n\n`);
    const later = () => (gapMs > 0 ? setTimeout(() => (res.write(": keepalive\n\n"), next()), gapMs) : setImmediate(next));
    if (more) later();
    else res.once("drain", later);
  };
  next();
}

function origin(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://origin");
  const number = (name: string, fallback: number) => {
    const value = Number(url.searchParams.get(name));
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  if (req.method === "GET" && url.pathname === "/api/health") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  if (req.method === "POST" && url.pathname === "/upload") {
    const hash = createHash("sha256");
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ bytes, sha256: hash.digest("hex") })));
    return;
  }
  if (req.method === "POST" && url.pathname === "/echo") {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    return void req.pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/bytes") return bytesRoute(req, res, number("n", 0));
  if (req.method === "GET" && url.pathname === "/sse") return sseRoute(res, number("events", 1), number("size", 1024), number("gapMs", 0));
  if (req.method === "GET" && url.pathname === "/wait") {
    const timer = setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end('{"waited":true}'), number("ms", 0));
    return void res.on("close", () => clearTimeout(timer));
  }
  if (req.method === "GET" && url.pathname === "/hang") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return void res.write("data: start\n\n");
  }
  res.writeHead(404).end();
}

const originServer = createServer(origin);
originServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (new URL(req.url ?? "/", "http://origin").pathname !== "/ws") return void socket.destroy();
  acceptWebSocket(req, socket, head, { protocol: null, maxPayload: 16 * 1024 * 1024 }, (connection) => ({
    message: (data) => connection.send(data),
    close: () => {},
  }));
});

const routes: Record<string, TransportByte | "impostor"> = {
  "/v1/e2e": TRANSPORT_DIRECT,
  "/test/relay-transport": TRANSPORT_RELAY,
  "/test/wrong-key": "impostor",
};

/** What a relay holding no key can do: answer with a fresh point and bytes of the right length. */
const impostorMessage2 = () => Buffer.concat([generateKeyPair().publicKey, randomBytes(JSON.stringify({ v: 1, conn: "x".repeat(22) }).length + TAG_BYTES)]);

const pingIntervalMs = arg("ping-interval-ms") ? Number(arg("ping-interval-ms")) : undefined;
const server = createServer((_req, res) => res.writeHead(404).end());
server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const route = routes[new URL(req.url ?? "/", "http://interop").pathname];
  if (!route) return void socket.destroy();
  if (route === "impostor") {
    acceptWebSocket(req, socket, head, { protocol: "omb-e2e.v1", maxPayload: MAX_RECORD_BYTES }, (connection) => ({
      message: () => connection.send(impostorMessage2()),
      close: () => {},
    }));
    return;
  }
  let session: E2ESession<string> | null = null;
  acceptWebSocket(req, socket, head, { protocol: "omb-e2e.v1", maxPayload: MAX_RECORD_BYTES }, (connection) => {
    session = E2ESession.computer({
      transport: connection,
      transportByte: route,
      staticKey: T,
      candidates: () => candidates,
      connectOrigin: () =>
        new Promise((resolve, reject) => {
          const port = (originServer.address() as AddressInfo).port;
          const originSocket = connect({ host: "127.0.0.1", port, allowHalfOpen: true }, () => resolve(originSocket));
          originSocket.once("error", reject);
        }),
      opened: (id, payload1) => console.error(`session ${req.url} ${id} ${payload1.app ?? ""}`),
      pingIntervalMs,
    });
    return {
      message: (data, binary) => session?.receive(data, binary),
      close: (code) => session?.transportClosed(code),
    };
  });
});

const listen = (target: ReturnType<typeof createServer>, port: number, host: string) =>
  new Promise<number>((resolve) => target.listen(port, host, () => resolve((target.address() as AddressInfo).port)));

const host = arg("host") ?? "127.0.0.1";
await listen(originServer, 0, "127.0.0.1");
const port = await listen(server, Number(arg("port") ?? 0), host);
const base = `ws://${host}:${port}`;
console.log(
  JSON.stringify({
    ready: true,
    port,
    direct: `${base}/v1/e2e`,
    relayTransport: `${base}/test/relay-transport`,
    wrongKey: `${base}/test/wrong-key`,
    k: b64u(T.publicKey),
    deviceToken: tokens.device,
    pairingToken: tokens.pairing,
  }),
);

const stop = () => {
  server.closeAllConnections();
  originServer.closeAllConnections();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (process.argv.includes("--exit-with-stdin")) {
  process.stdin.on("end", stop);
  process.stdin.resume();
}
