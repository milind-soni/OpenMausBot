// A stand-in for the MausBot Cloud Admin's side of the connector protocol (connector/src/protocol.ts): one-time codes,
// enrolment with the box's key, the channel's handshake (challenge, the box's signed auth with its connection count,
// the Admin's signed hello), signed jobs and their replies, signed configs, HTTP requests to the home over yamux
// streams, revocation and export uploads. The unit tests drive it in process; the e2e runs it as a program and drives it
// over its /control routes on loopback:
//   node connector/test/fake-admin.ts <port> <code>
import { randomBytes } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

import { MuxSession } from "../src/mux.ts";
import {
  CHANNEL_PROTOCOL, CLOSE_KEY_COPIED, CLOSE_PROTOCOL, CLOSE_REPLACED, CLOSE_UNAUTHORIZED, CONNECT_PATH, ENROLL_PATH, EXPORT_PATH, JOB_LIFETIME_MS, TRANSFER_SCHEME,
  authText, type BoxState, type ConfigPayload, type EnrollRequest, type EnrollResponse, type Heartbeat, type JobArgs, type JobReply, type JobType,
} from "../src/protocol.ts";
import { b64u, generateKeyPair, seal, unseal, verifyText, type KeyPair } from "../src/signed.ts";

export interface FakeBox {
  boxId: string;
  teamId: string;
  publicKey: string;
  state: BoxState;
  count: number;
  revoked: "revoked" | "copied" | null;
  enroll: EnrollRequest;
}

interface Live {
  ws: WebSocket;
  boxId: string;
  mux: MuxSession;
}

export interface JobOptions {
  /** Sign it for this box instead (to prove the box refuses it). */
  box?: string;
  /** Send it bare, not signed. */
  unsigned?: boolean;
  /** Sign it with this key instead of the Admin's. */
  key?: KeyPair;
  /** Signed this long ago. */
  ageMs?: number;
  timeoutMs?: number;
}

export class FakeAdmin {
  readonly codes = new Set<string>();
  readonly boxes = new Map<string, FakeBox>();
  readonly heartbeats: Heartbeat["heartbeat"][] = [];
  readonly replies: JobReply[] = [];
  /** Every reply message per job id, repeats included. */
  readonly replyCounts = new Map<string, number>();
  readonly exports = new Map<string, Buffer>();
  readonly connections: { boxId: string; count: number; at: number }[] = [];
  readonly closes: { boxId: string; code: number }[] = [];
  /** The Admin's signing keys by id; `hello` signs with `signingKid`. */
  readonly keys: Record<string, KeyPair> = { k1: generateKeyPair() };
  signingKid = "k1";
  /** Sign every hello with this key instead (a stranger pretending to be the Admin). */
  impostor: KeyPair | null = null;
  /** Keys to announce in the next hello (rotation). */
  announce: Record<string, string> | null = null;
  clockOffsetMs = 0;
  private live: Live | null = null;
  private readonly waiting = new Map<string, (reply: JobReply) => void>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private nextJob = 1;
  private configVersion = 0;

  constructor() {
    this.http = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        res.writeHead(500).end(String(error));
      });
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: (offered) => (offered.has(CHANNEL_PROTOCOL) ? CHANNEL_PROTOCOL : false) });
    this.http.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://admin").pathname !== CONNECT_PATH) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handshake(ws));
    });
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(port, "127.0.0.1", resolve));
    return this.origin;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  get connected(): boolean {
    return this.live !== null && this.live.ws.readyState === 1;
  }

  get liveBox(): string | null {
    return this.connected ? this.live!.boxId : null;
  }

  get publicKeys(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.keys).map(([kid, key]) => [kid, key.publicKey]));
  }

  mintCode(code = `MB-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`): string {
    this.codes.add(code);
    return code;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Drops the connection as a network failure would. */
  drop(): void {
    this.live?.mux.close();
    this.live?.ws.terminate();
    this.live = null;
  }

  /** Stops reading the connection, as a network that went quiet would. */
  freeze(): void {
    this.live?.ws.pause();
  }

  /** The team's Owner accepted the box: a signed config says so at once. */
  accept(boxId: string): void {
    this.boxes.get(boxId)!.state = "accepted";
    if (this.live?.boxId === boxId) this.sendConfig(boxId);
  }

  /** Revokes the box's key and closes its connection at once, as the Admin does. */
  revoke(boxId: string, why: "revoked" | "copied" = "revoked"): void {
    this.boxes.get(boxId)!.revoked = why;
    if (this.live?.boxId === boxId) this.closeLive(why === "copied" ? CLOSE_KEY_COPIED : CLOSE_UNAUTHORIZED, why);
  }

  send(message: unknown): void {
    if (!this.live) throw new Error("no connector is connected");
    this.live.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.live!.ws.send(bytes, { binary: true });
  }

  restarting(reconnectInMs: number, tryForMs: number): void {
    this.send({ t: "restarting", reconnectInMs, tryForMs });
    this.closeLive(1012, "restarting");
  }

  signJob(box: string, job: { id: string; type: string; args: unknown }, options: JobOptions = {}): string {
    const now = Date.now() + this.clockOffsetMs - (options.ageMs ?? 0);
    const key = options.key ?? this.keys[this.signingKid]!;
    return seal({ t: "job", box: options.box ?? box, iat: now, exp: now + JOB_LIFETIME_MS, job }, this.signingKid, key.privateKey);
  }

  /** Sends a job and resolves with the next reply to its id. */
  job<T extends JobType>(type: T, args: JobArgs[T] | Record<string, unknown>, id = `job-${this.nextJob++}`, options: JobOptions = {}): Promise<JobReply> {
    const reply = this.replyTo(id, options.timeoutMs ?? 30 * 60_000);
    const job = { id, type, args };
    this.send(options.unsigned ? job : { job: this.signJob(this.live!.boxId, job, options) });
    return reply;
  }

  sendConfig(boxId: string, patch: Partial<Pick<ConfigPayload, "schedule" | "policy">> & { version?: number } = {}): number {
    const version = patch.version ?? ++this.configVersion;
    this.configVersion = Math.max(this.configVersion, version);
    const payload: Omit<ConfigPayload, "kid"> = {
      t: "config", box: boxId, iat: Date.now() + this.clockOffsetMs, version, state: this.boxes.get(boxId)!.state,
      schedule: patch.schedule ?? { window: { days: [0], start: "02:00", end: "05:00", timeZone: "Europe/Berlin" }, ring: "standard", holdUntil: null, image: null },
      policy: patch.policy ?? { offlineHours: 72 },
    };
    this.send({ config: seal(payload, this.signingKid, this.keys[this.signingKid]!.privateKey) });
    return version;
  }

  /** One HTTP request to the home through the box, over a stream this side opens. */
  fetch(path: string, init: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
    const live = this.live;
    if (!live) throw new Error("no connector is connected");
    return new Promise((resolve, reject) => {
      const body = init.body ?? "";
      const req = request({
        // No agent: Node then asks createConnection for the socket, here a stream through the box.
        method: init.method ?? "GET", path, createConnection: () => live.mux.openStream() as never,
        headers: { host: init.host ?? "home.example.test", connection: "close", ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...init.headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body || undefined);
    });
  }

  /** The reply to a job id, whenever it arrives (a job answered after a reconnect, or by a new connector). */
  replyTo(id: string, timeoutMs = 30 * 60_000): Promise<JobReply> {
    const answered = this.replies.find((reply) => reply.id === id);
    if (answered) return Promise.resolve(answered);
    return new Promise<JobReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${id}`)), timeoutMs);
      this.waiting.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private closeLive(code: number, reason: string): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    live.mux.close();
    this.closes.push({ boxId: live.boxId, code });
    live.ws.close(code, reason);
  }

  private handshake(ws: WebSocket): void {
    const adminNonce = b64u(randomBytes(32));
    ws.send(JSON.stringify({ t: "challenge", v: 1, nonce: adminNonce }));
    ws.once("message", (data) => {
      let auth: { box?: string; count?: number; nonce?: string; sig?: string };
      try { auth = JSON.parse(String(data)) as typeof auth; } catch { return ws.close(CLOSE_PROTOCOL, "not JSON"); }
      const box = this.boxes.get(String(auth.box));
      if (!box || box.revoked) return ws.close(box?.revoked === "copied" ? CLOSE_KEY_COPIED : CLOSE_UNAUTHORIZED, "unknown box");
      if (typeof auth.count !== "number" || typeof auth.nonce !== "string" || typeof auth.sig !== "string"
        || !verifyText(box.publicKey, authText(box.boxId, adminNonce, auth.nonce, auth.count), auth.sig)) return ws.close(CLOSE_UNAUTHORIZED, "bad signature");
      if (auth.count <= box.count) {
        this.revoke(box.boxId, "copied");
        return ws.close(CLOSE_KEY_COPIED, "a copy of this key");
      }
      box.count = auth.count;
      this.closeLive(CLOSE_REPLACED, "a newer connection took over");
      const mux = new MuxSession("phone", {
        send: (frame) => ws.send(frame, { binary: true }),
        get bufferedAmount() { return ws.bufferedAmount; },
        onceDrained: (listener) => setTimeout(listener, 10),
      }, { failed: () => ws.close(CLOSE_PROTOCOL, "yamux") });
      const live: Live = { ws, boxId: box.boxId, mux };
      this.live = live;
      this.connections.push({ boxId: box.boxId, count: auth.count, at: Date.now() });
      const signer = this.impostor ?? this.keys[this.signingKid]!;
      ws.send(JSON.stringify({ t: "hello", signed: seal({
        t: "hello", box: box.boxId, adminNonce, boxNonce: auth.nonce, count: auth.count, now: Date.now() + this.clockOffsetMs, state: box.state,
        ...(this.announce ? { keys: this.announce } : {}),
      }, this.signingKid, signer.privateKey) }));
      ws.on("message", (message, binary) => {
        if (binary) return mux.receive(new Uint8Array(message as Buffer));
        this.received(String(message));
      });
      ws.on("close", () => {
        mux.close();
        if (this.live === live) this.live = null;
      });
    });
  }

  private received(text: string): void {
    const message = JSON.parse(text) as Heartbeat | JobReply;
    if ("heartbeat" in message) {
      this.heartbeats.push(message.heartbeat);
      return;
    }
    this.replyCounts.set(message.id, (this.replyCounts.get(message.id) ?? 0) + 1);
    this.send({ ack: message.id });
    if (this.replies.some((reply) => reply.id === message.id) && !this.waiting.has(message.id)) return;
    this.replies.push(message);
    const waiter = this.waiting.get(message.id);
    if (waiter) {
      this.waiting.delete(message.id);
      waiter(message);
    }
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  }

  /** The box a transfer's `Authorization: Box …` names, when its signature and lifetime hold. */
  private transferBox(header: string | undefined, jobId: string): FakeBox | null {
    const envelope = header?.startsWith(`${TRANSFER_SCHEME} `) ? header.slice(TRANSFER_SCHEME.length + 1) : "";
    const claimed = /^([^.]+)\./.exec(envelope)?.[1];
    let boxId = "";
    try { boxId = String((JSON.parse(Buffer.from(claimed ?? "", "base64url").toString("utf8")) as { box?: unknown }).box); } catch { return null; }
    const box = this.boxes.get(boxId);
    if (!box || box.revoked) return null;
    const opened = unseal(envelope, { box: box.publicKey });
    if (!opened.ok || opened.payload.t !== "transfer" || opened.payload.job !== jobId || Number(opened.payload.exp) < Date.now()) return null;
    return box;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://admin");
    if (req.method === "POST" && url.pathname === ENROLL_PATH) {
      let request: EnrollRequest;
      try { request = JSON.parse((await this.body(req)).toString("utf8")) as EnrollRequest; } catch { return this.json(res, 400, { error: "invalid_body" }); }
      if (!this.codes.delete(request.code)) return this.json(res, 401, { error: "invalid_code" });
      const answer: EnrollResponse = { boxId: `box_${randomBytes(8).toString("hex")}`, teamId: `team_${randomBytes(6).toString("hex")}`, adminKeys: this.publicKeys, state: "pending" };
      this.boxes.set(answer.boxId, { boxId: answer.boxId, teamId: answer.teamId, publicKey: request.publicKey, state: "pending", count: 0, revoked: null, enroll: request });
      return this.json(res, 200, answer);
    }
    if (req.method === "PUT" && url.pathname.startsWith(`${EXPORT_PATH}/`)) {
      const jobId = url.pathname.slice(EXPORT_PATH.length + 1);
      if (!this.transferBox(req.headers.authorization, jobId)) return this.json(res, 401, { error: "unauthorized" });
      this.exports.set(jobId, await this.body(req));
      return this.json(res, 200, { ok: true });
    }
    // The e2e's handle on this Admin; never part of the protocol.
    if (url.pathname === "/control/state" && req.method === "GET") {
      return this.json(res, 200, { connected: this.connected, servers: [...this.boxes.values()].map(({ boxId, teamId, state, count, revoked, enroll }) => ({ boxId, teamId, state, count, revoked, host: enroll.host, connector: enroll.connector })),
        heartbeats: this.heartbeats.length, lastHeartbeat: this.heartbeats.at(-1) ?? null, connections: this.connections.length });
    }
    if (url.pathname === "/control/accept" && req.method === "POST") {
      for (const box of this.boxes.values()) this.accept(box.boxId);
      return this.json(res, 200, { ok: true });
    }
    if (url.pathname === "/control/job" && req.method === "POST") {
      const { type, args, id } = JSON.parse((await this.body(req)).toString("utf8")) as { type: JobType; args: Record<string, unknown>; id?: string };
      try {
        return this.json(res, 200, await this.job(type, args, id));
      } catch (error) {
        return this.json(res, 504, { error: String(error) });
      }
    }
    if (url.pathname === "/control/reply" && req.method === "GET") {
      try {
        return this.json(res, 200, await this.replyTo(url.searchParams.get("id") ?? "", Number(url.searchParams.get("timeoutMs") ?? 600_000)));
      } catch (error) {
        return this.json(res, 504, { error: String(error) });
      }
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [port, code] = process.argv.slice(2);
  const admin = new FakeAdmin();
  if (code) admin.mintCode(code);
  const origin = await admin.listen(Number(port ?? 0));
  console.log(`fake admin on ${origin}`);
}
