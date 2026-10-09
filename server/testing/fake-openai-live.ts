#!/usr/bin/env node
// A stand-in for OpenAI's GPT-Live API, for tests and the isolated fixture.
// It speaks just enough HTTP and RFC 6455 WebSocket for the harness:
// POST /v1/live/sessions and GET /v1/live/sessions/:id/attach. Nothing here
// touches audio. Self-contained on purpose (node built-ins only).
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { pathToFileURL } from "node:url";

export interface FakeLiveSession {
  id: string;
  /** the API key the session was created with (its bearer) */
  key: string;
  body: Record<string, unknown>;
  commands: Array<Record<string, unknown>>;
  attached: boolean;
  closed: boolean;
}

export interface FakeOpenAiLive {
  url: string;
  sessions: FakeLiveSession[];
  failNextCreate(status: number, body?: unknown): void;
  refuseNextAttach(status: number): void;
  emit(sessionId: string, event: Record<string, unknown>): void;
  waitForAttach(sessionId: string, timeoutMs?: number): Promise<void>;
  waitForCommand(sessionId: string, match: (command: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  dropSideband(sessionId: string): void;
  stop(): Promise<void>;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** An SDP answer to `offer` that a real WebRTC client (browser, simulator,
 * emulator) accepts in setRemoteDescription, so it reaches its "live" state
 * against this fake. Media never connects: nothing listens on the one host
 * candidate. Audio answers with the offer's first codec, the data channel
 * with the offer's SCTP settings, anything else is rejected (port 0). */
export function fakeAnswerSdp(offer: string): string {
  const lines = offer.split(/\r?\n/).filter(Boolean);
  const firstMedia = lines.findIndex((line) => line.startsWith("m="));
  const session = firstMedia === -1 ? lines : lines.slice(0, firstMedia);
  const sections: string[][] = [];
  for (const line of firstMedia === -1 ? [] : lines.slice(firstMedia)) {
    if (line.startsWith("m=")) sections.push([line]);
    else sections.at(-1)!.push(line);
  }
  const ufrag = randomBytes(4).toString("hex");
  const pwd = randomBytes(16).toString("hex");
  const fingerprint = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const bundled = session.some((line) => line.startsWith("a=group:BUNDLE"));
  const accepted: string[] = [];
  const media = sections.map((section) => {
    const [kind = "", port = "0", proto = "", ...formats] = section[0].slice(2).split(" ");
    const attr = (name: string) => section.find((line) => line.startsWith(`a=${name}`));
    const mid = attr("mid:")?.slice("a=mid:".length) ?? "";
    const midLine = mid ? [`a=mid:${mid}`] : [];
    const supported = (kind === "audio" && formats.length > 0) || (kind === "application" && proto.includes("SCTP"));
    if (!supported || port === "0") return [`m=${kind} 0 ${proto} ${formats[0] ?? "0"}`, ...midLine];
    if (mid) accepted.push(mid);
    const transport = [
      "c=IN IP4 127.0.0.1",
      ...midLine,
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${fingerprint}`,
      // the offer is actpass (or passive); an active offer gets a passive answer
      `a=setup:${attr("setup:") === "a=setup:active" ? "passive" : "active"}`,
    ];
    const candidate = ["a=candidate:1 1 udp 2122260223 127.0.0.1 9 typ host", "a=end-of-candidates"];
    if (kind === "application") {
      const sctp = [attr("sctp-port:"), attr("max-message-size:")].filter((line): line is string => Boolean(line));
      return [`m=application 9 ${proto} ${formats.join(" ")}`, ...transport, ...sctp, ...candidate];
    }
    const codec = formats[0];
    const direction = attr("sendonly") ? "recvonly" : attr("recvonly") ? "sendonly" : attr("inactive") ? "inactive" : "sendrecv";
    return [
      `m=audio 9 ${proto} ${codec}`,
      ...transport,
      `a=${direction}`,
      "a=rtcp-mux",
      ...[attr(`rtpmap:${codec} `), attr(`fmtp:${codec} `)].filter((line): line is string => Boolean(line)),
      ...candidate,
    ];
  });
  const head = [
    "v=0",
    `o=- ${randomInt(1, 2 ** 47)} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    ...(bundled && accepted.length ? [`a=group:BUNDLE ${accepted.join(" ")}`] : []),
  ];
  return `${[...head, ...media.flat()].join("\r\n")}\r\n`;
}

function bearer(req: IncomingMessage): string {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
  return match?.[1] ?? "";
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(length), 2); return b; })();
  return Buffer.concat([head, payload]);
}

/** Pulls whole client frames (always masked) out of `buffer`. */
function readFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) { if (buffer.length - cursor < 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    else if (length === 127) { if (buffer.length - cursor < 8) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLength;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export async function startFakeOpenAiLive(options: { port?: number; closeOnRequest?: boolean } = {}): Promise<FakeOpenAiLive> {
  const sessions: FakeLiveSession[] = [];
  const sockets = new Map<string, Socket>();
  const waiters = new Set<() => void>();
  const wake = () => { for (const fn of Array.from(waiters)) fn(); };
  let nextCreateFailure: { status: number; body: unknown } | null = null;
  let nextAttachRefusal: number | null = null;
  let counter = 0;
  let eventCounter = 0;

  const send = (socket: Socket, event: Record<string, unknown>) => {
    if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify({ event_id: `evt_${++eventCounter}`, ...event }))));
  };

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/live/sessions") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!bearer(req)) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "missing key" } })); return; }
      if (nextCreateFailure) {
        const failure = nextCreateFailure;
        nextCreateFailure = null;
        res.writeHead(failure.status, { "content-type": "application/json" }).end(JSON.stringify(failure.body ?? { error: { message: "fake failure" } }));
        return;
      }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { /* recorded as {} */ }
      const session: FakeLiveSession = { id: `sess_fake_${++counter}`, key: bearer(req), body, commands: [], attached: false, closed: false };
      sessions.push(session);
      wake();
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
        session: { id: session.id, object: "live.session" },
        transport: { type: "webrtc", sdp: fakeAnswerSdp(String((body.transport as { sdp?: unknown } | undefined)?.sdp ?? "")) },
      }));
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    const match = /^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(req.url ?? "");
    const session = match ? sessions.find((s) => s.id === decodeURIComponent(match[1])) : undefined;
    const refuse = (status: number) => { socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (nextAttachRefusal !== null) { const status = nextAttachRefusal; nextAttachRefusal = null; refuse(status); return; }
    if (!session || !bearer(req) || session.closed) { refuse(session ? 401 : 404); return; }
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    session.attached = true;
    sockets.set(session.id, socket);
    wake();
    send(socket, { type: "session.started", session: { id: session.id, status: "active", expires_at: Math.floor(Date.now() / 1000) + 3600 } });
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); continue; }
        if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
        if (opcode !== 0x1) continue;
        let command: Record<string, unknown>;
        try { command = JSON.parse(payload.toString("utf8")) as Record<string, unknown>; } catch { continue; }
        session.commands.push(command);
        wake();
        if (command.type === "session.close" && options.closeOnRequest !== false) {
          session.closed = true;
          send(socket, { type: "session.closed", reason: "close_requested", usage: { seconds: 42 }, session: { id: session.id } });
          socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => { if (sockets.get(session.id) === socket) sockets.delete(session.id); });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const waitFor = <T>(check: () => T | undefined, timeoutMs: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const tryNow = () => {
        const value = check();
        if (value === undefined) return false;
        waiters.delete(tryNow);
        clearTimeout(timer);
        resolve(value);
        return true;
      };
      const timer = setTimeout(() => { waiters.delete(tryNow); reject(new Error(`fake GPT-Live: timed out waiting for ${what}`)); }, timeoutMs);
      if (!tryNow()) waiters.add(tryNow);
    });

  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    failNextCreate(status, body) { nextCreateFailure = { status, body }; },
    refuseNextAttach(status) { nextAttachRefusal = status; },
    emit(sessionId, event) {
      const socket = sockets.get(sessionId);
      if (!socket) throw new Error(`fake GPT-Live: ${sessionId} has no sideband`);
      send(socket, event);
    },
    waitForAttach(sessionId, timeoutMs = 5_000) {
      return waitFor(() => (sessions.find((s) => s.id === sessionId)?.attached ? true : undefined), timeoutMs, `attach of ${sessionId}`).then(() => undefined);
    },
    waitForCommand(sessionId, match, timeoutMs = 5_000) {
      return waitFor(() => sessions.find((s) => s.id === sessionId)?.commands.find(match), timeoutMs, `a command on ${sessionId}`);
    },
    dropSideband(sessionId) { sockets.get(sessionId)?.destroy(); },
    async stop() {
      for (const socket of sockets.values()) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// `node --experimental-strip-types server/testing/fake-openai-live.ts [port]`
// prints the base URL for OMB_OPENAI_LIVE_URL and runs until killed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeOpenAiLive({ port: Number(process.argv[2]) || 0 });
  process.stdout.write(`${fake.url}\n`);
}
