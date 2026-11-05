// The computer's side of MausBot Relay: one outbound control socket, and one data socket per phone session. The relay
// splices sealed bytes and can't open them; everything here is outside the encryption. Wire spec: README section 9.
import { webSocketTransport } from "./phone.ts";
import type { RecordTransport } from "./session.ts";

export const RELAY_PROTOCOL = "omb-relay.v1";
export type RelayStatus = "connected" | "connecting" | "off";

const BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
const DEFAULT_TIMING = {
  /** While on a later node, how often to try the first one again (± a fifth). */
  firstNodeRetryMs: 10 * 60_000,
  sleepCheckMs: 2_000,
  sleepJumpMs: 5_000,
  /** The pairing window expires on its own; the admission set is rechecked this often. */
  admissionCheckMs: 5_000,
};

export interface SessionSink {
  receive(data: Uint8Array, binary: boolean): void;
  transportClosed(code: number): void;
}

export interface RelayClientOptions {
  /** Hostnames in the order to try. */
  nodes: string[];
  token: string;
  admissionSet(): string[];
  /** A data socket is spliced: run the computer's session on it. */
  accept(transport: RecordTransport): SessionSink | null;
  /** 4401: the token is invalid or expired. The caller fetches one and calls setToken. */
  tokenRejected(): void;
  statusChanged?(status: RelayStatus, node: string | null): void;
  /** Test-only: `ws://127.0.0.1:<port>` in place of `wss://<node>`. */
  baseUrl?: (node: string) => string;
  random?: () => number;
  timing?: Partial<typeof DEFAULT_TIMING>;
}

interface ControlMessage {
  t?: unknown;
  sid?: unknown;
  node?: unknown;
  reconnectInMs?: unknown;
  tryForMs?: unknown;
}

const jitter = (ms: number, random: () => number) => Math.round(ms * (0.8 + 0.4 * random()));

export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #timing: typeof DEFAULT_TIMING;
  readonly #random: () => number;
  #nodes: string[];
  #token: string;
  #control: WebSocket | null = null;
  #controlNode = 0;
  #probe: WebSocket | null = null;
  #status: RelayStatus = "off";
  #attempt = 0;
  #stopped = true;
  #awaitingToken = false;
  #lastAdmit = "";
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #firstNodeTimer: ReturnType<typeof setTimeout> | null = null;
  #intervals: Array<ReturnType<typeof setInterval>> = [];

  constructor(options: RelayClientOptions) {
    this.#options = options;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#random = options.random ?? Math.random;
    this.#nodes = [...options.nodes];
    this.#token = options.token;
  }

  get status(): RelayStatus {
    return this.#status;
  }

  get node(): string | null {
    return this.#status === "connected" ? this.#nodes[this.#controlNode] ?? null : null;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#setStatus("connecting");
    this.#connect(0);
    let wall = Date.now();
    let mono = performance.now();
    this.#intervals.push(
      setInterval(() => {
        const nowWall = Date.now();
        const nowMono = performance.now();
        // A wall-clock jump the monotonic clock didn't see: the computer slept.
        const jumped = Math.abs(nowWall - wall - (nowMono - mono)) > this.#timing.sleepJumpMs;
        wall = nowWall;
        mono = nowMono;
        if (jumped) this.redial();
      }, this.#timing.sleepCheckMs),
      setInterval(() => this.refreshAdmission(), this.#timing.admissionCheckMs),
    );
    for (const interval of this.#intervals) interval.unref?.();
  }

  /** Data sockets already spliced keep running; their sessions end on their own. */
  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    for (const interval of this.#intervals) clearInterval(interval);
    this.#intervals = [];
    for (const socket of [this.#control, this.#probe]) socket?.close(1000);
    this.#control = null;
    this.#probe = null;
    this.#setStatus("off");
  }

  /** A refreshed token goes to the relay on the same socket; a refused one reconnects. */
  setToken(token: string, nodes?: string[]): void {
    this.#token = token;
    if (nodes && nodes.join(",") !== this.#nodes.join(",")) {
      this.#nodes = [...nodes];
      return this.redial();
    }
    if (this.#awaitingToken) {
      this.#awaitingToken = false;
      return this.#connect(this.#controlNode);
    }
    if (this.#status === "connected") this.#control?.send(JSON.stringify({ t: "auth", v: 1, token }));
  }

  /** After sleep, a network change or a resume: drop the control socket and dial the first node now. */
  redial(): void {
    if (this.#stopped) return;
    this.#clearTimers();
    const old = this.#control;
    this.#control = null;
    old?.close(1000);
    this.#attempt = 0;
    this.#setStatus("connecting");
    this.#connect(0);
  }

  /** Sends the full set whenever it differs from the last one sent. */
  refreshAdmission(force = false): void {
    if (this.#status !== "connected" || !this.#control) return;
    const set = this.#options.admissionSet();
    const text = JSON.stringify(set);
    if (!force && text === this.#lastAdmit) return;
    this.#lastAdmit = text;
    this.#control.send(JSON.stringify({ t: "admit", set }));
  }

  #url(node: string, path: string): string {
    return `${this.#options.baseUrl ? this.#options.baseUrl(node) : `wss://${node}`}${path}`;
  }

  #setStatus(status: RelayStatus): void {
    if (status === this.#status && status !== "connected") return;
    this.#status = status;
    this.#options.statusChanged?.(status, this.node);
  }

  #clearTimers(): void {
    for (const timer of [this.#retryTimer, this.#firstNodeTimer]) if (timer) clearTimeout(timer);
    this.#retryTimer = null;
    this.#firstNodeTimer = null;
  }

  #connect(index: number, probe = false): void {
    if (this.#stopped || this.#nodes.length === 0) return;
    const nodeIndex = index % this.#nodes.length;
    const socket = new WebSocket(this.#url(this.#nodes[nodeIndex], "/v1/host"), [RELAY_PROTOCOL]);
    if (probe) this.#probe = socket;
    else this.#control = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: "auth", v: 1, token: this.#token }));
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let message: ControlMessage;
      try {
        message = JSON.parse(event.data) as ControlMessage;
      } catch {
        return;
      }
      this.#onControlMessage(socket, nodeIndex, message);
    };
    socket.onclose = (event: CloseEvent) => this.#onControlClose(socket, nodeIndex, event.code, event.reason);
    socket.onerror = () => {};
  }

  #onControlMessage(socket: WebSocket, nodeIndex: number, message: ControlMessage): void {
    if (message.t === "hello") {
      if (socket === this.#probe) {
        // Back on the first node: the new socket first, then the old one goes.
        this.#probe = null;
        const old = this.#control;
        this.#control = socket;
        old?.close(1000);
      }
      if (socket !== this.#control) return;
      this.#controlNode = nodeIndex;
      this.#attempt = 0;
      this.#lastAdmit = "";
      this.#setStatus("connected");
      this.refreshAdmission(true);
      this.#scheduleFirstNode();
      return;
    }
    if (socket !== this.#control) return;
    if (message.t === "open" && typeof message.sid === "string" && /^[A-Za-z0-9_-]{22}$/.test(message.sid)) {
      return this.#openData(nodeIndex, message.sid);
    }
    if (message.t === "restarting") {
      const wait = (Number(message.reconnectInMs) || 0) + this.#random() * (Number(message.tryForMs) || 15_000);
      this.#control = null;
      socket.close(1000);
      this.#retry(nodeIndex + 1, Math.min(wait, 60_000));
    }
  }

  #onControlClose(socket: WebSocket, nodeIndex: number, code: number, reason: string): void {
    if (socket === this.#probe) {
      this.#probe = null;
      return this.#scheduleFirstNode();
    }
    if (socket !== this.#control || this.#stopped) return;
    this.#control = null;
    if (code === 4409) return this.stop();
    const wasConnected = this.#status === "connected";
    this.#setStatus("connecting");
    if (code === 4401) {
      this.#awaitingToken = true;
      this.#controlNode = nodeIndex;
      return this.#options.tokenRejected();
    }
    if (code === 4503) {
      let retryInMs = 5_000;
      try {
        retryInMs = Number((JSON.parse(reason) as { retryInMs?: unknown }).retryInMs) || retryInMs;
      } catch {
        // The default stands.
      }
      return this.#retry(nodeIndex + 1, Math.min(retryInMs, 60_000) + this.#random() * 1_000);
    }
    const delay = jitter(BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)], this.#random);
    this.#attempt += 1;
    this.#retry(wasConnected ? nodeIndex : nodeIndex + 1, delay);
  }

  #retry(index: number, delayMs: number): void {
    if (this.#stopped) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect(index);
    }, delayMs);
    this.#retryTimer.unref?.();
  }

  #scheduleFirstNode(): void {
    if (this.#firstNodeTimer) clearTimeout(this.#firstNodeTimer);
    this.#firstNodeTimer = null;
    if (this.#controlNode === 0 || this.#stopped) return;
    this.#firstNodeTimer = setTimeout(() => {
      this.#firstNodeTimer = null;
      if (!this.#probe && this.#controlNode !== 0) this.#connect(0, true);
    }, jitter(this.#timing.firstNodeRetryMs, this.#random));
    this.#firstNodeTimer.unref?.();
  }

  #openData(nodeIndex: number, sid: string): void {
    const socket = new WebSocket(this.#url(this.#nodes[nodeIndex], "/v1/host/data"), [RELAY_PROTOCOL]);
    socket.binaryType = "arraybuffer";
    let sink: SessionSink | null = null;
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "data", v: 1, sid, token: this.#token }));
      sink = this.#options.accept(webSocketTransport(socket));
    };
    socket.onmessage = (event: MessageEvent) => {
      const binary = typeof event.data !== "string";
      sink?.receive(binary ? new Uint8Array(event.data as ArrayBuffer) : Buffer.from(event.data as string, "utf8"), binary);
    };
    socket.onclose = (event: CloseEvent) => sink?.transportClosed(event.code);
    socket.onerror = () => {};
  }
}
