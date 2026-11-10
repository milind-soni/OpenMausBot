// The connector's one connection to the Admin: outbound, held open, re-opened with backoff and jitter. Each connection
// starts with both sides proving their keys. Then the Admin's jobs arrive on it, each signed for this box, and their
// replies go back, again on each new connection until the Admin acknowledges them; the Admin's requests to the home
// arrive as yamux streams.
import { randomBytes } from "node:crypto";

import { errorText, type Log } from "./log.ts";
import { MuxSession, type MuxStream } from "./mux.ts";
import {
  BOX_HEADER, CHANNEL_DEAD_MS, CHANNEL_PING_MS, CHANNEL_PROTOCOL, CLOSE_KEY_COPIED, CLOSE_PROTOCOL, CLOSE_REPLACED, CLOSE_SILENT,
  CLOSE_UNAUTHORIZED, CONNECT_PATH, HANDSHAKE_MS, HEARTBEAT_INTERVAL_MS, TRANSFER_SCHEME, TRANSFER_TOKEN_MS, authText, checkConfig, checkHello, checkJob,
  checkJobPayload, checkNonce, type Auth, type BoxState, type ConfigPayload, type Heartbeat, type Job, type JobAck, type JobErrorCode, type JobReply,
  type JobType, type TransferPayload,
} from "./protocol.ts";
import { b64u, seal, signText, unseal } from "./signed.ts";
import type { AgentRecord, ConfigRecord, StatusRecord } from "./state.ts";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const KEPT_REPLIES = 200;
const UNACKED_MAX_AGE_MS = 24 * 60 * 60_000;
const STABLE_MS = 60_000;
const UNAUTHORIZED_RETRY_MS = 5 * 60_000;
const REPLACED_RETRY_MS = 60_000;
const RESTART_WAIT_MAX_MS = 5 * 60_000;
const DRAIN_POLL_MS = 50;
/** Jobs a box the team's Owner has not accepted yet still answers: they read, and carry none of the team's data. */
const READS: ReadonlySet<JobType> = new Set(["status", "host-health"]);

export interface Socket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, init: { headers: Record<string, string>; protocols: string[] }) => Socket;

/** Node's own WebSocket client (undici), which takes request headers. */
export const nodeSocket: SocketFactory = (url, init) => new WebSocket(url, init as unknown as string[]) as unknown as Socket;

export interface Refusal {
  code: JobErrorCode;
  message: string;
  id?: string;
  type?: string;
}

export interface AgentOptions {
  /** This box's record, read at each use: the Admin's keys can change in a hello. */
  identity: () => AgentRecord;
  log: Log;
  socket?: SocketFactory;
  heartbeat: () => Promise<Heartbeat>;
  handle: (job: Job) => Promise<JobReply | null>;
  /** The next connection's count, already on the disk. */
  nextCount: () => number;
  /** A hello named new Admin keys: pin them. */
  saveAdminKeys?: (keys: Record<string, string>) => void;
  config?: { saved(): ConfigRecord | null; save(record: ConfigRecord): void };
  onConfig?: (config: ConfigPayload) => void;
  /** A stream the Admin opened: one request for the home. */
  stream?: (stream: MuxStream, accept: () => void) => void;
  /** A job refused before it ran; for the audit log. */
  refused?: (refusal: Refusal) => void;
  status?: (patch: Partial<StatusRecord>) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  heartbeatMs?: number;
  pingMs?: number;
  deadMs?: number;
  handshakeMs?: number;
}

function isAck(message: unknown): message is JobAck {
  return typeof message === "object" && message !== null && typeof (message as JobAck).ack === "string" && Object.keys(message).length === 1;
}

export function connectUrl(admin: string): string {
  const url = new URL(CONNECT_PATH, admin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** 1 s, 2 s, 4 s … up to a minute, each between half and one and a half times that, so many servers spread out. */
export function backoffMs(attempt: number, random: number): number {
  return Math.round(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)) * (0.5 + random));
}

const textOf = (data: unknown): string | null =>
  typeof data === "string" ? data : null;

const bytesOf = (data: unknown): Uint8Array | null =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;

type Phase = "challenge" | "hello" | "open";

interface Connection {
  socket: Socket;
  phase: Phase;
  adminNonce: string;
  boxNonce: string;
  count: number;
  /** The Admin's clock minus this one's, from the hello. */
  offset: number;
  mux: MuxSession | null;
  heardAt: number;
  pings: number;
}

export class Agent {
  private readonly options: AgentOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private connection: Connection | null = null;
  private attempt = 0;
  private openedAt = 0;
  private retry: unknown = null;
  private beat: unknown = null;
  private tick: unknown = null;
  private deadline: unknown = null;
  private restartIn: number | null = null;
  private stopped = true;
  private boxState: BoxState | null = null;
  /** Replies the Admin has not acknowledged yet, sent again on each connection. */
  private readonly unacked = new Map<string, { text: string; at: number }>();
  private readonly replies = new Map<string, JobReply | "running">();
  /** Called once each time the Admin has accepted a connection. */
  onConnected: (() => void) | null = null;

  constructor(options: AgentOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get connected(): boolean {
    return this.connection?.phase === "open" && this.connection.socket.readyState === 1;
  }

  /** What the Admin said of this box last: pending until the team's Owner accepts it. */
  get state(): BoxState | null {
    return this.boxState;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Closes the connection and stops re-opening it; replies made meanwhile wait for `start()`. */
  stop(): void {
    this.stopped = true;
    if (this.retry) this.clearTimer(this.retry);
    this.retry = null;
    const connection = this.connection;
    this.detach();
    connection?.mux?.goAway();
    try { connection?.socket.close(1000, "connector stopping"); } catch { /* already closed */ }
    this.options.status?.({ connected: false });
  }

  /** A reply to send now and on each new connection, until the Admin acknowledges it. */
  reply(reply: JobReply): void {
    this.replies.set(reply.id, reply);
    while (this.replies.size > KEPT_REPLIES) this.replies.delete(this.replies.keys().next().value as string);
    const text = JSON.stringify(reply);
    this.unacked.delete(reply.id);
    this.unacked.set(reply.id, { text, at: this.now() });
    for (const [id, entry] of this.unacked) {
      if (this.unacked.size <= KEPT_REPLIES && this.now() - entry.at < UNACKED_MAX_AGE_MS) break;
      this.unacked.delete(id);
    }
    this.send(text);
  }

  private send(text: string): void {
    if (!this.connected) return;
    try {
      this.connection!.socket.send(text);
    } catch (error) {
      this.options.log(`could not send to MausBot: ${errorText(error)}`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const identity = this.options.identity();
    let socket: Socket;
    try {
      socket = (this.options.socket ?? nodeSocket)(connectUrl(identity.admin), { headers: { [BOX_HEADER]: identity.boxId }, protocols: [CHANNEL_PROTOCOL] });
      socket.binaryType = "arraybuffer";
    } catch (error) {
      this.options.log(`could not open the connection to MausBot: ${errorText(error)}`);
      this.scheduleRetry(backoffMs(this.attempt++, this.random()));
      return;
    }
    const connection: Connection = { socket, phase: "challenge", adminNonce: "", boxNonce: "", count: 0, offset: 0, mux: null, heardAt: this.now(), pings: 0 };
    this.connection = connection;
    socket.onopen = () => {
      if (this.connection !== connection) return;
      this.deadline = this.setTimer(() => {
        if (this.connection === connection && connection.phase !== "open") this.drop(CLOSE_SILENT, "MausBot did not finish the handshake");
      }, this.options.handshakeMs ?? HANDSHAKE_MS);
    };
    socket.onmessage = (event) => {
      if (this.connection !== connection) return;
      connection.heardAt = this.now();
      this.received(connection, event.data);
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.connection !== connection) return;
      this.closed(event.code, event.reason);
    };
  }

  /** Forgets the connection at once: a dead network may never deliver its close. */
  private drop(code: number, why: string): void {
    const connection = this.connection;
    if (!connection) return;
    this.options.log(`dropping the connection to MausBot: ${why}`);
    try { connection.socket.close(code, why.slice(0, 120)); } catch { /* already closed */ }
    this.closed(code, why);
  }

  private detach(): void {
    const connection = this.connection;
    this.connection = null;
    this.openedAt = 0;
    for (const timer of [this.beat, this.tick, this.deadline]) if (timer) this.clearTimer(timer);
    this.beat = this.tick = this.deadline = null;
    connection?.mux?.close();
  }

  private closed(code: number, reason: string): void {
    const wasOpen = this.openedAt > 0;
    const lasted = wasOpen ? this.now() - this.openedAt : 0;
    this.detach();
    if (lasted >= STABLE_MS) this.attempt = 0;
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_KEY_COPIED) {
      const why = code === CLOSE_KEY_COPIED
        ? "MausBot saw another server use this server's key, so it stopped trusting the key"
        : "MausBot no longer knows this server";
      this.options.status?.({ connected: false, unauthorized: true, lastError: why });
      this.options.log(`${why}; run the install command again with a new code to connect it`);
      this.scheduleRetry(UNAUTHORIZED_RETRY_MS);
      return;
    }
    this.options.status?.({ connected: false, lastError: wasOpen ? `the connection closed (${code})` : "MausBot could not be reached" });
    if (wasOpen) this.options.log(`the connection to MausBot closed (${code}${reason ? `: ${reason}` : ""})`);
    if (this.restartIn !== null) {
      const wait = this.restartIn;
      this.restartIn = null;
      this.scheduleRetry(wait);
      return;
    }
    this.scheduleRetry(code === CLOSE_REPLACED ? REPLACED_RETRY_MS : backoffMs(this.attempt++, this.random()));
  }

  private scheduleRetry(ms: number): void {
    if (this.stopped) return;
    if (this.retry) this.clearTimer(this.retry);
    this.retry = this.setTimer(() => {
      this.retry = null;
      this.connect();
    }, ms);
  }

  private received(connection: Connection, data: unknown): void {
    const bytes = bytesOf(data);
    if (bytes) {
      if (connection.phase !== "open" || !connection.mux) return this.drop(CLOSE_PROTOCOL, "a binary message before the handshake");
      connection.mux.receive(bytes);
      return;
    }
    const text = textOf(data);
    if (text === null || text.length > MAX_MESSAGE_BYTES) return this.drop(CLOSE_PROTOCOL, "a message too large");
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      if (connection.phase !== "open") return this.drop(CLOSE_PROTOCOL, "a handshake message that is not JSON");
      this.options.log("ignored a message from MausBot that is not JSON");
      return;
    }
    if (connection.phase === "challenge") return this.challenged(connection, message);
    if (connection.phase === "hello") return this.greeted(connection, message);
    this.dispatch(connection, message);
  }

  private challenged(connection: Connection, message: Record<string, unknown>): void {
    if (message.t !== "challenge" || message.v !== 1 || !checkNonce(message.nonce)) return this.drop(CLOSE_PROTOCOL, "MausBot did not start the handshake");
    const identity = this.options.identity();
    let count: number;
    try {
      count = this.options.nextCount();
    } catch (error) {
      return this.drop(CLOSE_PROTOCOL, `the connection count could not be saved (${errorText(error)})`);
    }
    connection.adminNonce = message.nonce;
    connection.boxNonce = b64u(randomBytes(32));
    connection.count = count;
    connection.phase = "hello";
    const auth: Auth = { t: "auth", v: 1, box: identity.boxId, count, nonce: connection.boxNonce,
      sig: signText(identity.privateKey, authText(identity.boxId, connection.adminNonce, connection.boxNonce, count)) };
    connection.socket.send(JSON.stringify(auth));
  }

  private greeted(connection: Connection, message: Record<string, unknown>): void {
    const identity = this.options.identity();
    const opened = message.t === "hello" ? unseal(message.signed, identity.adminKeys) : { ok: false as const, why: "not a hello" };
    if (!opened.ok) {
      this.options.status?.({ lastError: `the MausBot at ${identity.admin} did not prove it holds MausBot's key (${opened.why})` });
      return this.drop(CLOSE_PROTOCOL, `MausBot's hello did not verify: ${opened.why}`);
    }
    const hello = checkHello(opened.payload, { box: identity.boxId, adminNonce: connection.adminNonce, boxNonce: connection.boxNonce, count: connection.count });
    if (!hello.ok) return this.drop(CLOSE_PROTOCOL, hello.message);
    if (this.deadline) this.clearTimer(this.deadline);
    this.deadline = null;
    if (hello.value.keys) this.options.saveAdminKeys?.(hello.value.keys);
    connection.offset = hello.value.now - this.now();
    connection.phase = "open";
    connection.mux = new MuxSession("computer", {
      send: (frame) => connection.socket.send(frame),
      get bufferedAmount() { return connection.socket.bufferedAmount; },
      onceDrained: (listener) => this.whenDrained(connection, listener),
    }, {
      incoming: (stream, accept) => (this.options.stream ? this.options.stream(stream, accept) : stream.destroy()),
      failed: (reason) => this.drop(CLOSE_PROTOCOL, `a yamux error (${reason})`),
    });
    this.openedAt = this.now();
    this.setState(hello.value.state);
    this.options.status?.({ connected: true, unauthorized: false, lastConnectedAt: this.openedAt, lastError: null });
    this.options.log(`connected to MausBot (${hello.value.state === "pending" ? "waiting for the team's Owner to accept this server" : "accepted"})`);
    for (const { text } of this.unacked.values()) connection.socket.send(text);
    this.startBeat(connection);
    this.onConnected?.();
  }

  private whenDrained(connection: Connection, listener: () => void): void {
    const check = () => {
      if (this.connection !== connection || connection.socket.bufferedAmount <= 0) return listener();
      this.setTimer(check, DRAIN_POLL_MS);
    };
    this.setTimer(check, DRAIN_POLL_MS);
  }

  private setState(state: BoxState): void {
    if (state === this.boxState) return;
    this.boxState = state;
    this.options.status?.({ boxState: state });
  }

  private dispatch(connection: Connection, message: Record<string, unknown>): void {
    if (isAck(message)) {
      this.unacked.delete(message.ack);
      return;
    }
    if (typeof message.job === "string") return this.signedJob(connection, message.job);
    if (typeof message.config === "string") return this.signedConfig(message.config);
    if (message.t === "restarting") {
      const wait = Math.min(RESTART_WAIT_MAX_MS, Math.max(0, Number(message.reconnectInMs) || 0));
      const spread = Math.min(RESTART_WAIT_MAX_MS, Math.max(0, Number(message.tryForMs) || 0));
      this.restartIn = Math.round(wait + this.random() * spread);
      return;
    }
    if ("id" in message || "type" in message) {
      this.refuse({ code: "unsigned_job", message: "a job MausBot did not sign" });
      return;
    }
    this.options.log("ignored a message from MausBot this connector does not know");
  }

  private refuse(refusal: Refusal, reply = false): void {
    this.options.log(`refused a job${refusal.id ? ` ${refusal.id}` : ""}: ${refusal.message}`);
    this.options.refused?.(refusal);
    if (reply && refusal.id) this.reply({ id: refusal.id, ok: false, error: { code: refusal.code, message: refusal.message } });
  }

  private signedJob(connection: Connection, envelope: string): void {
    const identity = this.options.identity();
    const opened = unseal(envelope, identity.adminKeys);
    if (!opened.ok) return this.refuse({ code: "unsigned_job", message: `a job MausBot did not sign (${opened.why})` });
    const payload = checkJobPayload(opened.payload, identity.boxId, this.now() + connection.offset);
    const claimed = typeof opened.payload.job === "object" && opened.payload.job !== null ? opened.payload.job as { id?: unknown; type?: unknown } : {};
    const id = typeof claimed.id === "string" ? claimed.id.slice(0, 64) : undefined;
    if (!payload.ok) return this.refuse({ code: payload.code, message: payload.message, id, type: typeof claimed.type === "string" ? claimed.type.slice(0, 32) : undefined }, true);
    const checked = checkJob(payload.job);
    if (!checked.ok) {
      if (checked.id) this.reply({ id: checked.id, ok: false, error: { code: checked.code, message: checked.message } });
      else this.options.log(`ignored a job without a valid id: ${checked.message}`);
      return;
    }
    const { job } = checked;
    const known = this.replies.get(job.id);
    if (known === "running") return;
    if (known) {
      this.reply(known);
      return;
    }
    if (this.boxState !== "accepted" && !READS.has(job.type)) {
      return this.refuse({ code: "pending_box", message: "The team's Owner has not accepted this server in MausBot yet.", id: job.id, type: job.type }, true);
    }
    this.replies.set(job.id, "running");
    this.options.log(`job ${job.id}: ${job.type}`);
    this.options.handle(job).then((reply) => {
      if (reply === null) {
        this.replies.delete(job.id);
        return;
      }
      this.options.log(`job ${job.id}: ${reply.ok ? "done" : `failed (${reply.error.code})`}`);
      this.reply(reply);
    }, (error) => this.reply({ id: job.id, ok: false, error: { code: "docker", message: errorText(error) } }));
  }

  private signedConfig(envelope: string): void {
    const identity = this.options.identity();
    const opened = unseal(envelope, identity.adminKeys);
    if (!opened.ok) return void this.options.log(`ignored a config MausBot did not sign (${opened.why})`);
    const config = checkConfig(opened.payload, identity.boxId);
    if (!config.ok) return void this.options.log(`ignored a config: ${config.message}`);
    this.setState(config.value.state);
    const saved = this.options.config?.saved();
    if (saved && saved.version >= config.value.version) return;
    try {
      this.options.config?.save({ envelope, version: config.value.version, savedAt: this.now() });
    } catch (error) {
      this.options.log(`could not keep MausBot's config on this server: ${errorText(error)}`);
    }
    this.options.onConfig?.(config.value);
  }

  private startBeat(connection: Connection): void {
    const beat = () => {
      this.heartbeat();
      this.beat = this.setTimer(beat, this.options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    };
    beat();
    const pingMs = this.options.pingMs ?? CHANNEL_PING_MS;
    const deadMs = this.options.deadMs ?? CHANNEL_DEAD_MS;
    const tick = () => {
      if (this.connection !== connection) return;
      // The wall clock: after a suspended VM resumes, it has moved on while timers stood still.
      if (this.now() - connection.heardAt > deadMs) return this.drop(CLOSE_SILENT, `nothing from MausBot for ${Math.round(deadMs / 1000)} s`);
      connection.pings = (connection.pings + 1) >>> 0;
      connection.mux?.ping(connection.pings);
      this.tick = this.setTimer(tick, pingMs);
    };
    this.tick = this.setTimer(tick, pingMs);
  }

  private heartbeat(): void {
    this.options.heartbeat().then((beat) => {
      if (!this.connected) return;
      this.connection!.socket.send(JSON.stringify(beat));
      this.options.status?.({ lastHeartbeatAt: this.now() });
    }, (error) => this.options.log(`could not make a heartbeat: ${errorText(error)}`));
  }
}

/** The saved config, verified again with the keys pinned now, for use while the Admin can't be reached. */
export function savedConfig(record: ConfigRecord | null, identity: AgentRecord): ConfigPayload | null {
  if (!record) return null;
  const opened = unseal(record.envelope, identity.adminKeys);
  if (!opened.ok) return null;
  const config = checkConfig(opened.payload, identity.boxId);
  return config.ok ? config.value : null;
}

/** `Authorization` for a transfer of job `jobId` to or from the Admin: a short token this box signs. */
export function transferAuthorization(identity: AgentRecord, jobId: string, now = Date.now()): string {
  const payload: Omit<TransferPayload, "kid"> = { t: "transfer", box: identity.boxId, job: jobId, iat: now, exp: now + TRANSFER_TOKEN_MS };
  return `${TRANSFER_SCHEME} ${seal(payload, "box", identity.privateKey)}`;
}
