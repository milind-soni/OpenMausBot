// The connector's one connection to the Admin: outbound, held open, re-opened with backoff. Jobs arrive on it and
// their replies go back on it, again on each new connection until the Admin acknowledges them.
import { errorText, type Log } from "./log.ts";
import { CLOSE_REPLACED, CLOSE_UNAUTHORIZED, CONNECT_PATH, HEARTBEAT_INTERVAL_MS, checkJob, type Heartbeat, type Job, type JobAck, type JobReply } from "./protocol.ts";
import type { StatusRecord } from "./state.ts";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const KEPT_REPLIES = 200;
const UNACKED_MAX_AGE_MS = 24 * 60 * 60_000;
const STABLE_MS = 60_000;
const UNAUTHORIZED_RETRY_MS = 5 * 60_000;
const REPLACED_RETRY_MS = 60_000;

export interface Socket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => Socket;

/** Node's own WebSocket client (undici), which takes request headers. */
export const nodeSocket: SocketFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as Socket;

export interface AgentOptions {
  admin: string;
  token: string;
  log: Log;
  socket?: SocketFactory;
  heartbeat: () => Promise<Heartbeat>;
  handle: (job: Job) => Promise<JobReply | null>;
  status?: (patch: Partial<StatusRecord>) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  heartbeatMs?: number;
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

export class Agent {
  private readonly options: AgentOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private socket: Socket | null = null;
  private attempt = 0;
  private openedAt = 0;
  private retry: unknown = null;
  private beat: unknown = null;
  private stopped = true;
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
    return this.socket?.readyState === 1 && this.openedAt > 0;
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
    this.stopBeat();
    const socket = this.socket;
    this.socket = null;
    this.openedAt = 0;
    socket?.close(1000, "connector stopping");
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
      this.socket!.send(text);
    } catch (error) {
      this.options.log(`could not send to MausBot: ${errorText(error)}`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: Socket;
    try {
      socket = (this.options.socket ?? nodeSocket)(connectUrl(this.options.admin), { authorization: `Bearer ${this.options.token}` });
    } catch (error) {
      this.options.log(`could not open the connection to MausBot: ${errorText(error)}`);
      this.scheduleRetry(backoffMs(this.attempt++, this.random()));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = this.now();
      this.options.status?.({ connected: true, unauthorized: false, lastConnectedAt: this.openedAt, lastError: null });
      this.options.log("connected to MausBot");
      for (const { text } of this.unacked.values()) socket.send(text);
      this.startBeat();
      this.onConnected?.();
    };
    socket.onmessage = (event) => this.received(event.data);
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      const wasOpen = this.openedAt > 0;
      const lasted = wasOpen ? this.now() - this.openedAt : 0;
      this.socket = null;
      this.openedAt = 0;
      this.stopBeat();
      if (lasted >= STABLE_MS) this.attempt = 0;
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.options.status?.({ connected: false, unauthorized: true, lastError: "MausBot no longer knows this server" });
        this.options.log("MausBot no longer knows this server; run the install command again with a new code to connect it");
        this.scheduleRetry(UNAUTHORIZED_RETRY_MS);
        return;
      }
      this.options.status?.({ connected: false, lastError: wasOpen ? `the connection closed (${event.code})` : "MausBot could not be reached" });
      if (wasOpen) this.options.log(`the connection to MausBot closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      this.scheduleRetry(event.code === CLOSE_REPLACED ? REPLACED_RETRY_MS : backoffMs(this.attempt++, this.random()));
    };
  }

  private scheduleRetry(ms: number): void {
    if (this.stopped) return;
    if (this.retry) this.clearTimer(this.retry);
    this.retry = this.setTimer(() => {
      this.retry = null;
      this.connect();
    }, ms);
  }

  private startBeat(): void {
    this.stopBeat();
    const tick = () => {
      this.heartbeat();
      this.beat = this.setTimer(tick, this.options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    };
    tick();
  }

  private stopBeat(): void {
    if (this.beat) this.clearTimer(this.beat);
    this.beat = null;
  }

  private heartbeat(): void {
    this.options.heartbeat().then((beat) => {
      if (!this.connected) return;
      this.socket!.send(JSON.stringify(beat));
      this.options.status?.({ lastHeartbeatAt: this.now() });
    }, (error) => this.options.log(`could not make a heartbeat: ${errorText(error)}`));
  }

  private received(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : null;
    if (text === null || text.length > MAX_MESSAGE_BYTES) {
      this.options.log("ignored a message from MausBot that is not a job");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.options.log("ignored a message from MausBot that is not JSON");
      return;
    }
    if (isAck(message)) {
      this.unacked.delete(message.ack);
      return;
    }
    const checked = checkJob(message);
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
}
