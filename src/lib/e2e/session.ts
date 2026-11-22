import { b64u, type Bytes } from "./bytes.ts";
import { encodePayload1, MAX_RECORD_BYTES, newConn, NoiseError, phoneHello, TRANSPORT_DIRECT, TRANSPORT_RELAY, type SessionKeys } from "./noise.ts";
import { decodeFrame, encodeFrame, GO_AWAY, Mux, PING_INTERVAL_MS, PING_TIMEOUT_MS, YamuxError, type Frame } from "./yamux.ts";

export const DIRECT_PROTOCOL = "omb-e2e.v1";
export const RELAY_PROTOCOL = "omb-relay.v1";

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocol: 4000,
  rejected: 4001,
  deadline: 4002,
  relayBadMessage: 4400,
  relayNotHere: 4404,
  relayBusy: 4503,
} as const;

export const HANDSHAKE_DEADLINE_MS = 10_000;
/** The relay adds a hop and the host's data socket: its attempt gets this much more. */
const RELAY_EXTRA_MS = 10_000;
/** A sender stops writing records while the socket holds more than this. */
export const SEND_BUFFER_HIGH = 1024 * 1024;
/** The browser WebSocket has no drain event, so a congested writer checks this often. */
const DRAIN_POLL_MS = 5;
/** The readable side holds this much before the computer is told to wait. */
const READ_HIGH_WATER = 256 * 1024;
/** The longest wait a 4503 can ask for. */
const MAX_RETRY_MS = 60_000;
/** Records held while message 2 is checked: control frames only, since no stream is open yet. */
const MAX_EARLY_RECORDS = 64;
const MAX_EARLY_BYTES = MAX_RECORD_BYTES;

export class SessionClosed extends Error {
  readonly code: number;
  /** A 4503's `{"retryInMs":N}`. */
  readonly retryInMs?: number;
  /** The computer said, inside the encryption, that this device was removed (GoAway 3) just before the close. */
  readonly removed: boolean;
  constructor(code: number, retryInMs?: number, removed = false) {
    super(`e2e session closed (${code})`);
    this.code = code;
    this.retryInMs = retryInMs;
    this.removed = removed;
  }
}

/** Codes a browser may send; any other closes without one. */
const sendable = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);
const closeSocket = (socket: WebSocket, code: number) => (sendable(code) ? socket.close(code) : socket.close());

interface Timers {
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

export interface DialOptions extends Timers {
  /** `ws://host:port/v1/e2e` for Wi-Fi and Tailscale, `wss://relayN.openmausbot.com/v1/phone` for the relay. The direct
   * route refuses any Origin header (README section 4), so a web page always goes through the relay. */
  url: string;
  /** The pinned transport key `T.pub`. */
  remoteStatic: Bytes;
  psk: Bytes;
  app: string;
  /** The relay route: sent before the handshake, which then uses the relay prologue. */
  relay?: { hostId: Bytes; adm: Bytes };
  /** The whole attempt, handshake included: 10 s direct, 20 s through the relay. */
  timeoutMs?: number;
}

export interface RelayDialOptions extends Omit<DialOptions, "url" | "relay"> {
  /** The relay nodes' phone URLs, best first. */
  urls: readonly string[];
  hostId: Bytes;
  adm: Bytes;
}

/** One stream: the computer's origin answers what is written. */
export interface E2EStream {
  readonly id: number;
  /** Errors with "stream reset" on RST or when the session closes. Cancelling it resets the stream. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Resolves once every byte is handed to the session; rejects if the stream is reset first. */
  write(bytes: Uint8Array): Promise<void>;
  /** No more writes: FIN after what is already written. */
  end(): void;
  reset(): void;
  /** Resolves on the computer's FIN: all it will send is in `readable`, read or not. */
  readonly ended: Promise<void>;
}

/** Rejects with SessionClosed (the close code) or a NoiseError (a hard stop: the computer could not be verified). */
export async function dial(options: DialOptions): Promise<PhoneSession> {
  const { relay } = options;
  const hello = phoneHello(
    { remoteStatic: options.remoteStatic, psk: options.psk, transport: relay ? TRANSPORT_RELAY : TRANSPORT_DIRECT },
    encodePayload1(newConn(), options.app),
  );
  // A bad key or psk is reported when message 1 is due; until then the rejection is held here.
  hello.catch(() => {});
  // Read at the call, like every other option, so later changes to the caller's bytes don't reach the wire.
  const preAuth = relay && JSON.stringify({ t: "phone", v: 1, hid: b64u(relay.hostId), adm: b64u(relay.adm) });
  const socket = new WebSocket(options.url, [relay ? RELAY_PROTOCOL : DIRECT_PROTOCOL]);
  socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    let stage: "connecting" | "relay" | "message2" | "finishing" | "done" = "connecting";
    /** Records that arrive while message 2 is checked go to the session in order. */
    const early: MessageEvent[] = [];
    let earlyBytes = 0;
    /** More arrived than a session's start can need; the queue is dropped and the session refused once verified. */
    let overflowed = false;
    /** A close while message 2 is checked: a failed check wins over it, since a node's 4404 must not hide a hard stop. */
    let closedWhileFinishing: CloseEvent | null = null;
    const fail = (error: Error, code?: number) => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      clearTimeout(noiseTimer);
      reject(error);
      if (code !== undefined) closeSocket(socket, code);
    };
    const timer = setTimeout(
      () => fail(new SessionClosed(CLOSE.deadline), CLOSE.deadline),
      options.timeoutMs ?? HANDSHAKE_DEADLINE_MS + (relay ? RELAY_EXTRA_MS : 0),
    );
    let noiseTimer: ReturnType<typeof setTimeout> | undefined;
    const sendMessage1 = () => {
      stage = "message2";
      // The handshake's own 10 s run from the socket opening, or from the relay's ready (README section 5).
      noiseTimer = setTimeout(() => fail(new SessionClosed(CLOSE.deadline), CLOSE.deadline), HANDSHAKE_DEADLINE_MS);
      hello.then(
        (started) => {
          if (stage === "message2") socket.send(started.message1);
        },
        (error: Error) => fail(error, CLOSE.normal),
      );
    };
    socket.onopen = () => {
      if (!preAuth) return sendMessage1();
      stage = "relay";
      socket.send(preAuth);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (stage === "relay") {
        // Before the handshake, only the relay's ready.
        if (typeof event.data === "string" && isReady(event.data)) return sendMessage1();
        return fail(new SessionClosed(CLOSE.relayBadMessage), CLOSE.normal);
      }
      if (stage === "finishing") {
        // Before the session exists the phone has opened no stream, so only a few control records can be due. Too many
        // is a protocol error, reported after the check so that a message 2 that fails to verify still stops hard.
        if (overflowed) return;
        earlyBytes += typeof event.data === "string" ? event.data.length : (event.data as ArrayBuffer).byteLength;
        if (early.length < MAX_EARLY_RECORDS && earlyBytes <= MAX_EARLY_BYTES) return void early.push(event);
        overflowed = true;
        early.length = 0;
        return;
      }
      if (stage !== "message2" || typeof event.data === "string") return fail(new SessionClosed(CLOSE.protocol), CLOSE.protocol);
      stage = "finishing";
      hello
        .then((started) => started.finish(new Uint8Array(event.data as ArrayBuffer)))
        .then(
          (keys) => {
            if (stage !== "finishing") return;
            if (overflowed) return fail(new SessionClosed(CLOSE.protocol), CLOSE.protocol);
            stage = "done";
            clearTimeout(timer);
            clearTimeout(noiseTimer);
            const session = new PhoneSession(socket, keys, options);
            for (const message of early) session.receive(message);
            if (!closedWhileFinishing) return resolve(session);
            // Closed already: the records before the close are read first, so a GoAway(3) among them is told apart
            // from a bare 4001 the relay may have sent on its own.
            const event = closedWhileFinishing;
            socket.onclose?.call(socket, event);
            // The session's own code wins: a record that fails to open is a 4000, never the relay's retryable close.
            void session.closed.then((code) =>
              reject(code === event.code ? closedBy(event, session.removed) : new SessionClosed(code, undefined, session.removed)),
            );
          },
          (error: Error) => fail(error, CLOSE.protocol),
        );
    };
    socket.onclose = (event: CloseEvent) => {
      if (stage === "finishing") closedWhileFinishing = event;
      else fail(closedBy(event));
    };
    socket.onerror = () => {};
  });
}

const closedBy = (event: CloseEvent, removed = false) =>
  new SessionClosed(event.code, event.code === CLOSE.relayBusy ? retryDelay(event.reason) : undefined, removed);

/** `{"retryInMs":N}` with N a whole number of ms, at most a minute; anything else asks for no wait. */
function retryDelay(reason: string): number | undefined {
  try {
    const value = (JSON.parse(reason) as { retryInMs?: unknown } | null)?.retryInMs;
    return Number.isSafeInteger(value) && (value as number) >= 0 ? Math.min(value as number, MAX_RETRY_MS) : undefined;
  } catch {
    return undefined;
  }
}

function isReady(text: string): boolean {
  try {
    return (JSON.parse(text) as { t?: unknown } | null)?.t === "ready";
  } catch {
    return false;
  }
}

/** Tries each node in order. 4404 (not connected or not admitted here) moves on at once; 4503 (full or restarting)
 * waits the `retryInMs` it gives, plus jitter, first. Any other failure, or the last node's, is the caller's to back
 * off from. */
export async function dialRelay(options: RelayDialOptions): Promise<PhoneSession> {
  // Copied at the call: the caller may reuse or wipe its arrays while the nodes are tried.
  const { urls, hostId, adm, remoteStatic, psk, ...rest } = options;
  const nodes = [...urls];
  const relay = { hostId: hostId.slice(), adm: adm.slice() };
  const keys = { remoteStatic: remoteStatic.slice(), psk: psk.slice() };
  let last = new SessionClosed(CLOSE.relayNotHere);
  for (const [index, url] of nodes.entries()) {
    if (index > 0 && last.retryInMs) await sleep(last.retryInMs * (1 + Math.random() * 0.2));
    try {
      return await dial({ ...rest, ...keys, url, relay });
    } catch (error) {
      if (!(error instanceof SessionClosed) || (error.code !== CLOSE.relayNotHere && error.code !== CLOSE.relayBusy)) throw error;
      last = error;
    }
  }
  throw last;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface PendingWrite {
  bytes: Uint8Array;
  resolve(): void;
  reject(error: Error): void;
}

class Stream implements E2EStream {
  readonly id: number;
  readonly readable: ReadableStream<Uint8Array>;
  readonly ended: Promise<void>;
  readonly #session: PhoneSession;
  #markEnded!: () => void;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #writes: PendingWrite[] = [];
  #ending = false;
  #finSent = false;
  #remoteEnded = false;
  #done = false;
  /** Delivered but not yet granted back, because the reader is behind. */
  #ungranted = 0;

  constructor(session: PhoneSession, id: number) {
    this.#session = session;
    this.id = id;
    this.ended = new Promise((resolve) => (this.#markEnded = resolve));
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          if (this.#ungranted === 0) return;
          const bytes = this.#ungranted;
          this.#ungranted = 0;
          this.#session.mux?.consumed(this.id, bytes);
        },
        cancel: () => this.reset(),
      },
      { highWaterMark: READ_HIGH_WATER, size: (chunk) => chunk.byteLength },
    );
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#done || this.#ending) return Promise.reject(new Error(this.#done ? "stream reset" : "stream ended"));
    return new Promise((resolve, reject) => {
      this.#writes.push({ bytes: bytes.slice(), resolve, reject });
      this.flush();
    });
  }

  end(): void {
    if (this.#done || this.#ending) return;
    this.#ending = true;
    this.flush();
  }

  reset(): void {
    const mux = this.#session.mux;
    if (mux?.has(this.id)) mux.reset(this.id);
    this.remoteReset();
  }

  /** Granted back as the reader takes it, so a slow reader slows the computer. */
  deliver(data: Uint8Array): void {
    if (this.#done) return;
    this.#controller.enqueue(data.slice());
    if ((this.#controller.desiredSize ?? 0) > 0) this.#session.mux?.consumed(this.id, data.length);
    else this.#ungranted += data.length;
  }

  remoteEnded(): void {
    if (this.#done) return;
    this.#remoteEnded = true;
    this.#controller.close();
    this.#markEnded();
    this.#forgetIfDone();
  }

  /** Both FINs seen: the mux has dropped the stream without an event, so the session drops it too. */
  #forgetIfDone(): void {
    if (!this.#finSent || !this.#remoteEnded) return;
    this.#done = true;
    this.#session.forget(this.id);
  }

  remoteReset(): void {
    if (this.#done) return;
    this.#done = true;
    this.#session.forget(this.id);
    const error = new Error("stream reset");
    try {
      this.#controller.error(error);
    } catch {
      // Already closed by the computer's FIN: nothing more to read either way.
    }
    for (const pending of this.#writes.splice(0)) pending.reject(error);
  }

  flush(): void {
    const mux = this.#session.mux;
    while (!this.#done && this.#writes.length > 0) {
      if (!mux?.has(this.id)) return this.remoteReset();
      if (this.#session.congested) return this.#session.whenDrained(() => this.flush());
      const head = this.#writes[0];
      const taken = mux.write(this.id, head.bytes);
      if (taken === 0 && head.bytes.length > 0) return;
      head.bytes = head.bytes.subarray(taken);
      if (head.bytes.length > 0) continue;
      this.#writes.shift();
      head.resolve();
    }
    if (!this.#done && this.#ending && !this.#finSent && this.#writes.length === 0 && mux?.has(this.id)) {
      this.#finSent = true;
      mux.finish(this.id);
      this.#forgetIfDone();
    }
  }
}

/** "closing": the last records are being sent before the socket closes. */
type State = "open" | "closing" | "closed";

/** An open session. Built by dial() once message 2 checks out. */
export class PhoneSession {
  readonly #socket: WebSocket;
  readonly #keys: SessionKeys;
  readonly #mux: Mux;
  readonly #streams = new Map<number, Stream>();
  #state: State = "open";
  /** Records not yet sealed, which the socket's buffered amount does not count yet. */
  #unsealed = 0;
  #sending: Promise<void> = Promise.resolve();
  /** Bytes handed to the socket so far; less its buffered amount, what has gone out. */
  #handed = 0;
  #pingTimer: ReturnType<typeof setInterval>;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingPong: number | null = null;
  #pingCounter = 0;
  #drainWaiters: Array<() => void> = [];
  #removed = false;
  /** Records still being opened, and the socket's close code if it closed meanwhile. */
  #opening = 0;
  #closedMeanwhile: number | null = null;
  #settleClosed!: (code: number) => void;
  readonly closed: Promise<number>;

  constructor(socket: WebSocket, keys: SessionKeys, timers: Timers = {}) {
    this.#socket = socket;
    this.#keys = keys;
    this.closed = new Promise((resolve) => {
      this.#settleClosed = resolve;
    });
    this.#mux = new Mux("phone", {
      send: (frame) => this.#send(frame),
      data: (streamId, data) => this.#streams.get(streamId)?.deliver(data),
      ended: (streamId) => this.#streams.get(streamId)?.remoteEnded(),
      reset: (streamId) => this.#streams.get(streamId)?.remoteReset(),
      writable: (streamId) => this.#streams.get(streamId)?.flush(),
      goAway: (code) => {
        if (code === GO_AWAY.removed) this.#removed = true;
        else if (code !== GO_AWAY.normal) this.close(CLOSE.protocol);
      },
      pong: (value) => {
        if (value !== this.#awaitingPong) return;
        this.#awaitingPong = null;
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
      },
    });
    socket.onmessage = (event: MessageEvent) => this.receive(event);
    // A record already received, such as GoAway(3) just before a 4001, is read before the close ends the session.
    socket.onclose = (event: CloseEvent) => {
      if (this.#opening === 0) return this.#end(event.code);
      // The socket is gone, so no pong can come: only the records already in may still settle the session.
      this.#closedMeanwhile = event.code;
      this.#stopLiveness();
    };
    const pingTimeoutMs = timers.pingTimeoutMs ?? PING_TIMEOUT_MS;
    this.#pingTimer = setInterval(() => this.#ping(pingTimeoutMs), timers.pingIntervalMs ?? PING_INTERVAL_MS);
  }

  get mux(): Mux | null {
    return this.#state === "open" ? this.#mux : null;
  }

  get state(): State {
    return this.#state;
  }

  /** The computer said, inside the encryption, that this device was removed (GoAway 3). Only this, or a 4001 on a
   * direct route, means "pair again"; a bare 4001 through the relay may be the relay's own. */
  get removed(): boolean {
    return this.#removed;
  }

  get congested(): boolean {
    return this.#socket.bufferedAmount + this.#unsealed > SEND_BUFFER_HIGH;
  }

  whenDrained(listener: () => void): void {
    this.#drainWaiters.push(listener);
    if (this.#drainWaiters.length > 1) return;
    const check = () => {
      if (this.#state === "open" && this.#socket.bufferedAmount + this.#unsealed > SEND_BUFFER_HIGH / 4) return void setTimeout(check, DRAIN_POLL_MS);
      for (const waiter of this.#drainWaiters.splice(0)) waiter();
    };
    setTimeout(check, DRAIN_POLL_MS);
  }

  forget(streamId: number): void {
    this.#streams.delete(streamId);
  }

  open(): E2EStream {
    if (this.#state !== "open") throw new SessionClosed(CLOSE.normal);
    const stream = new Stream(this, this.#mux.open());
    this.#streams.set(stream.id, stream);
    return stream;
  }

  /** Every message after message 2, in order. */
  receive(event: MessageEvent): void {
    if (this.#state !== "open") return;
    if (typeof event.data === "string") return this.close(CLOSE.protocol);
    // Opens settle one at a time in call order, so frames reach the mux in wire order.
    this.#opening += 1;
    this.#keys.receive
      .open(new Uint8Array(event.data as ArrayBuffer))
      .then(
        (plaintext) => {
          if (this.#state !== "open") return;
          try {
            this.#mux.receive(decodeFrame(plaintext));
          } catch (error) {
            if (!(error instanceof YamuxError)) throw error;
            this.#mux.protocolError();
            this.#closeAfterSending(CLOSE.protocol);
          }
        },
        () => this.close(CLOSE.protocol),
      )
      .finally(() => {
        this.#opening -= 1;
        if (this.#opening === 0 && this.#closedMeanwhile !== null) this.#end(this.#closedMeanwhile);
      });
  }

  /** A planned close: GoAway first, so the computer knows it isn't an error. */
  shutdown(): void {
    if (this.#state !== "open") return;
    this.#mux.goAway(GO_AWAY.normal);
    this.#closeAfterSending(CLOSE.normal);
  }

  /** Sends what is queued (a GoAway last), then closes; nothing new is sent or read meanwhile. */
  #closeAfterSending(code: number): void {
    this.#state = "closing";
    // The planned close wins: a ping that times out meanwhile must not cut the GoAway short.
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#sending.then(() => this.close(code));
  }

  close(code: number): void {
    if (this.#state === "closed") return;
    closeSocket(this.#socket, code);
    this.#end(code);
  }

  #end(code: number): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#stopLiveness();
    // Each reset forgets its stream; a Map may drop the entry being visited.
    for (const stream of this.#streams.values()) stream.remoteReset();
    this.#mux.closeAll();
    for (const waiter of this.#drainWaiters.splice(0)) waiter();
    this.#settleClosed(code);
  }

  #stopLiveness(): void {
    clearInterval(this.#pingTimer);
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#awaitingPong = null;
  }

  #ping(timeoutMs: number): void {
    if (this.#awaitingPong !== null || this.#state !== "open") return;
    this.#pingCounter = (this.#pingCounter + 1) >>> 0;
    this.#awaitingPong = this.#pingCounter;
    this.#mux.ping(this.#pingCounter);
    // The deadline is for the computer's answer, so it starts once the ping has gone out, not while the ping waits
    // behind an upload. A socket that sends nothing for as long is stalled, and closes the same way.
    const ping = this.#awaitingPong;
    void this.#sending.then(() => {
      const pingSent = this.#handed;
      let gone = -Infinity;
      let since = Date.now();
      const check = () => {
        if (this.#state !== "open" || this.#awaitingPong !== ping) return;
        const now = this.#handed - this.#socket.bufferedAmount;
        if (now >= pingSent) return void (this.#pongTimer = setTimeout(() => this.close(CLOSE.goingAway), timeoutMs));
        if (now > gone) [gone, since] = [now, Date.now()];
        else if (Date.now() - since >= timeoutMs) return this.close(CLOSE.goingAway);
        this.#pongTimer = setTimeout(check, DRAIN_POLL_MS);
      };
      check();
    });
  }

  /** Seals start now, in frame order, so each takes the next nonce; sends wait for every earlier record. A seal's
   * failure is caught at once, so it is not unhandled while an earlier record is still being sealed. */
  #send(frame: Frame): void {
    if (this.#state !== "open") return;
    const plaintext = encodeFrame(frame);
    this.#unsealed += plaintext.length;
    const sealed = this.#keys.send.seal(plaintext).then(
      (record) => ({ record }),
      (error: unknown) => ({ error }),
    );
    this.#sending = this.#sending.then(async () => {
      const result = await sealed;
      this.#unsealed -= plaintext.length;
      // The counter ran out: close before it could repeat; the phone reconnects.
      if ("error" in result) return this.close(result.error instanceof NoiseError ? CLOSE.normal : CLOSE.protocol);
      if (this.#state === "closed") return;
      this.#socket.send(result.record);
      this.#handed += result.record.length;
    });
  }
}
