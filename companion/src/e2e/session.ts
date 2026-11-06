// One encrypted session over any message transport: the handshake, then records carrying yamux frames, each stream
// a Node Duplex. The computer pipes every stream to its own origin socket; the phone hands streams to an HTTP stack.
import { Duplex } from "node:stream";

import {
  CLOSE,
  computerAccept,
  encodePayload1,
  HANDSHAKE_DEADLINE_MS,
  newConn,
  NoiseError,
  NONCE_LIMIT,
  phoneHello,
  type KeyPair,
  type Payload1,
  type PhoneHello,
  type PskCandidate,
  type SessionKeys,
  type TransportByte,
} from "./noise.ts";
import { b64u } from "./credentials.ts";
import { decodeFrame, encodeFrame, GO_AWAY, Mux, PING_INTERVAL_MS, PING_TIMEOUT_MS, YamuxError, type Frame, type Role } from "./yamux.ts";

/** A sender stops writing records while the socket holds more than this. */
export const SEND_BUFFER_HIGH = 1024 * 1024;

/** A WebSocket, as the session needs it: binary messages out, a close, and backpressure. */
export interface RecordTransport {
  send(message: Uint8Array): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount: number;
  onceDrained(listener: () => void): void;
}

export class SessionClosed extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`e2e session closed (${code})`);
    this.code = code;
  }
}

interface Timers {
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  handshakeDeadlineMs?: number;
}

export interface ComputerSessionOptions<Id> extends Timers {
  transport: RecordTransport;
  transportByte: TransportByte;
  staticKey: KeyPair;
  /** Read when message 1 arrives, so a revoke or a closed pairing window applies at once. */
  candidates(): ReadonlyArray<PskCandidate<Id>>;
  /** A fresh connection to the private origin listener, per stream. */
  connectOrigin(): Promise<Duplex>;
  opened?(id: Id, payload1: Payload1): void;
}

export interface PhoneSessionOptions extends Timers {
  transport: RecordTransport;
  transportByte: TransportByte;
  remoteStatic: Uint8Array;
  psk: Uint8Array;
  app: string;
  /** Test-only. */
  ephemeral?: KeyPair;
}

const noop = () => {};

export class MuxStream extends Duplex {
  readonly streamId: number;
  readonly #session: E2ESession<unknown>;
  #pending: Buffer | null = null;
  #pendingDone: ((error?: Error | null) => void) | null = null;
  #ungranted = 0;

  constructor(session: E2ESession<unknown>, streamId: number) {
    super({ allowHalfOpen: true, readableHighWaterMark: 256 * 1024 });
    this.#session = session;
    this.streamId = streamId;
    // A reset reaches whoever listens; without a listener it must not take the process down.
    this.on("error", noop);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.#pending = chunk;
    this.#pendingDone = done;
    this.flush();
  }

  override _final(done: (error?: Error | null) => void): void {
    this.#session.mux?.finish(this.streamId);
    done();
  }

  override _read(): void {
    if (this.#ungranted === 0) return;
    const bytes = this.#ungranted;
    this.#ungranted = 0;
    this.#session.mux?.consumed(this.streamId, bytes);
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    const mux = this.#session.mux;
    if (mux?.has(this.streamId)) mux.reset(this.streamId);
    this.#session.forget(this.streamId);
    const pendingDone = this.#pendingDone;
    this.#pending = null;
    this.#pendingDone = null;
    pendingDone?.(error ?? new Error("stream reset"));
    done(error);
  }

  /** Granted back as the reader takes it, so a slow reader slows the sender. */
  deliver(data: Buffer): void {
    if (this.push(data)) this.#session.mux?.consumed(this.streamId, data.length);
    else this.#ungranted += data.length;
  }

  remoteEnded(): void {
    this.push(null);
  }

  remoteReset(): void {
    if (!this.destroyed) this.destroy(new Error("stream reset"));
  }

  flush(): void {
    const mux = this.#session.mux;
    while (this.#pending && this.#pending.length > 0) {
      if (!mux || !mux.has(this.streamId)) return void this.destroy(new Error("stream reset"));
      if (this.#session.congested) return this.#session.whenDrained(() => this.flush());
      
      const taken = mux.write(this.streamId, this.#pending);
      if (taken === 0) return;
      this.#pending = this.#pending.subarray(taken);
    }
    const done = this.#pendingDone;
    this.#pending = null;
    this.#pendingDone = null;
    done?.();
  }
}

type State = "handshake" | "open" | "closed";

export class E2ESession<Id> {
  readonly role: Role;
  readonly #transport: RecordTransport;
  readonly #streams = new Map<number, MuxStream>();
  readonly #timers: Required<Timers>;
  #state: State = "handshake";
  #keys: SessionKeys | null = null;
  #mux: Mux | null = null;
  #accept: ((message: Buffer) => void) | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingPong: number | null = null;
  #pingCounter = 0;
  #drainWaiters: Array<() => void> = [];
  #settleReady!: (error?: Error) => void;
  #settleClosed!: (code: number) => void;
  #connectOrigin: (() => Promise<Duplex>) | null = null;
  /** The computer side: which device (or pairing window) this is. */
  peer: Id | null = null;
  readonly ready: Promise<void>;
  readonly closed: Promise<number>;

  private constructor(role: Role, transport: RecordTransport, timers: Timers) {
    this.role = role;
    this.#transport = transport;
    this.#timers = {
      pingIntervalMs: timers.pingIntervalMs ?? PING_INTERVAL_MS,
      pingTimeoutMs: timers.pingTimeoutMs ?? PING_TIMEOUT_MS,
      handshakeDeadlineMs: timers.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS,
    };
    this.ready = new Promise((resolve, reject) => {
      this.#settleReady = (error) => (error ? reject(error) : resolve());
    });
    this.ready.catch(noop);
    this.closed = new Promise((resolve) => {
      this.#settleClosed = resolve;
    });
    this.#deadline = setTimeout(() => this.close(CLOSE.deadline), this.#timers.handshakeDeadlineMs);
    this.#deadline.unref?.();
  }

  /** Waits for message 1. Anything wrong with it closes 4001 and nothing else is sent. */
  static computer<Id>(options: ComputerSessionOptions<Id>): E2ESession<Id> {
    const session = new E2ESession<Id>("computer", options.transport, options);
    session.#connectOrigin = options.connectOrigin;
    session.#accept = (message) => {
      const accepted = computerAccept({ staticKey: options.staticKey, transport: options.transportByte, candidates: options.candidates() }, message);
      if (!accepted) return session.close(CLOSE.rejected);
      options.transport.send(accepted.message2);
      session.peer = accepted.id;
      session.#start(accepted.keys);
      options.opened?.(accepted.id, accepted.payload1);
    };
    return session;
  }

  /** Sends message 1 now. `ready` rejects with a NoiseError when the computer can't be verified: a hard stop. */
  static phone(options: PhoneSessionOptions): E2ESession<never> {
    const session = new E2ESession<never>("phone", options.transport, options);
    const conn = newConn();
    const hello: PhoneHello = phoneHello(
      { remoteStatic: options.remoteStatic, psk: options.psk, transport: options.transportByte, ephemeral: options.ephemeral },
      encodePayload1(conn, options.app),
      b64u(conn),
    );
    session.#accept = (message) => {
      let keys: SessionKeys;
      try {
        keys = hello.finish(message);
      } catch (error) {
        session.#settleReady(error as Error);
        return session.close(CLOSE.protocol);
      }
      session.#start(keys);
    };
    options.transport.send(hello.message1);
    return session;
  }

  get mux(): Mux | null {
    return this.#mux;
  }

  get state(): State {
    return this.#state;
  }

  get congested(): boolean {
    return this.#transport.bufferedAmount > SEND_BUFFER_HIGH;
  }

  get activeStreams(): number {
    return this.#streams.size;
  }

  whenDrained(listener: () => void): void {
    this.#drainWaiters.push(listener);
    if (this.#drainWaiters.length > 1) return;
    this.#transport.onceDrained(() => {
      const waiters = this.#drainWaiters;
      this.#drainWaiters = [];
      for (const waiter of waiters) waiter();
    });
  }

  forget(streamId: number): void {
    this.#streams.delete(streamId);
  }

  /** Every message the transport receives, in order. */
  receive(message: Uint8Array, binary: boolean): void {
    if (this.#state === "closed") return;
    if (this.#state === "handshake") {
      const accept = this.#accept;
      this.#accept = null;
      if (!binary || !accept) return this.close(this.role === "computer" ? CLOSE.rejected : CLOSE.protocol);
      return accept(Buffer.from(message));
    }
    if (!binary) return this.close(CLOSE.protocol);
    let plaintext: Buffer;
    try {
      plaintext = (this.#keys as SessionKeys).receive.open(message);
    } catch {
      return this.close(CLOSE.protocol);
    }
    try {
      (this.#mux as Mux).receive(decodeFrame(plaintext));
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      this.#mux?.protocolError();
      this.close(CLOSE.protocol);
    }
  }

  /** The phone side. */
  openStream(): MuxStream {
    if (this.#state !== "open" || !this.#mux) throw new SessionClosed(CLOSE.normal);
    const streamId = this.#mux.open();
    const stream = new MuxStream(this as E2ESession<unknown>, streamId);
    this.#streams.set(streamId, stream);
    return stream;
  }

  /** A planned close (quit, sleep, restart): GoAway first, so the peer knows it isn't an error. */
  shutdown(): void {
    if (this.#state === "open") this.#mux?.goAway(GO_AWAY.normal);
    this.close(CLOSE.normal);
  }

  close(code: number, reason?: string): void {
    if (this.#state === "closed") return;
    this.#transport.close(code, reason);
    this.#end(code);
  }

  /** The transport closed under us. */
  transportClosed(code: number): void {
    this.#end(code);
  }

  #end(code: number): void {
    if (this.#state === "closed") return;
    const wasHandshake = this.#state === "handshake";
    this.#state = "closed";
    for (const timer of [this.#deadline, this.#pongTimer]) if (timer) clearTimeout(timer);
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#mux?.closeAll();
    for (const stream of this.#streams.values()) stream.remoteReset();
    this.#streams.clear();
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const waiter of waiters) waiter();
    if (wasHandshake) this.#settleReady(new SessionClosed(code));
    this.#settleClosed(code);
  }

  #start(keys: SessionKeys): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#keys = keys;
    this.#state = "open";
    this.#mux = new Mux(this.role, {
      send: (frame) => this.#send(frame),
      opened: (streamId) => this.#openOrigin(streamId),
      data: (streamId, data) => this.#streams.get(streamId)?.deliver(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
      ended: (streamId) => this.#streams.get(streamId)?.remoteEnded(),
      reset: (streamId) => {
        const stream = this.#streams.get(streamId);
        this.#streams.delete(streamId);
        stream?.remoteReset();
      },
      writable: (streamId) => this.#streams.get(streamId)?.flush(),
      goAway: (code) => {
        if (code !== GO_AWAY.normal) this.close(CLOSE.protocol);
      },
      pong: (value) => {
        if (value !== this.#awaitingPong) return;
        this.#awaitingPong = null;
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
      },
    });
    this.#pingTimer = setInterval(() => this.#ping(), this.#timers.pingIntervalMs);
    this.#pingTimer.unref?.();
    this.#settleReady();
  }

  #ping(): void {
    if (this.#awaitingPong !== null || !this.#mux) return;
    this.#pingCounter = (this.#pingCounter + 1) >>> 0;
    this.#awaitingPong = this.#pingCounter;
    this.#mux.ping(this.#pingCounter);
    this.#pongTimer = setTimeout(() => this.close(CLOSE.goingAway), this.#timers.pingTimeoutMs);
    this.#pongTimer.unref?.();
  }

  #send(frame: Frame): void {
    if (this.#state !== "open" || !this.#keys) return;
    let record: Buffer;
    try {
      record = this.#keys.send.seal(encodeFrame(frame));
    } catch (error) {
      if (error instanceof NoiseError) return this.close(CLOSE.normal);
      throw error;
    }
    this.#transport.send(record);
    // Well before the counter could repeat; the phone reconnects.
    if (this.#keys.send.nonce >= NONCE_LIMIT - 1024) queueMicrotask(() => this.close(CLOSE.normal));
  }

  #openOrigin(streamId: number): void {
    const stream = new MuxStream(this as E2ESession<unknown>, streamId);
    this.#streams.set(streamId, stream);
    const connect = this.#connectOrigin;
    if (!connect) return void stream.destroy();
    connect().then(
      (socket) => {
        if (stream.destroyed || this.#state !== "open") return void socket.destroy();
        this.#mux?.accept(streamId);
        socket.on("error", () => stream.destroy());
        socket.on("close", () => {
          if (!socket.readableEnded) stream.destroy();
        });
        stream.on("close", () => socket.destroy());
        stream.pipe(socket);
        socket.pipe(stream);
      },
      () => stream.destroy(),
    );
  }
}
