// yamux streams over the box channel's binary WebSocket messages, one frame per message, each stream a Node Duplex.
// The Admin opens every stream (yamux.ts calls that side the "phone"); the connector accepts each one (the "computer")
// and pipes it to the home. The Admin copies this file as it is.
import { Duplex } from "node:stream";

import { decodeFrame, encodeFrame, GO_AWAY, Mux, YamuxError, type Frame, type Role } from "./yamux.ts";

/** A sender stops writing frames while the socket holds more than this. */
export const SEND_BUFFER_HIGH = 1024 * 1024;

export interface FrameTransport {
  send(frame: Uint8Array): void;
  readonly bufferedAmount: number;
  onceDrained(listener: () => void): void;
}

export interface MuxHooks {
  /** The accepting side: a new stream. Call `accept()` once its far end is ready, or destroy the stream to refuse it. */
  incoming?(stream: MuxStream, accept: () => void): void;
  /** A frame broke the profile, or the peer went away with an error: the caller closes the connection. */
  failed(reason: string): void;
  pong?(value: number): void;
}

const noop = () => {};

export class MuxStream extends Duplex {
  readonly streamId: number;
  readonly #session: MuxSession;
  #pending: Buffer | null = null;
  #pendingDone: ((error?: Error | null) => void) | null = null;
  #ungranted = 0;

  constructor(session: MuxSession, streamId: number) {
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
    this.#session.mux.finish(this.streamId);
    done();
  }

  override _read(): void {
    if (this.#ungranted === 0) return;
    const bytes = this.#ungranted;
    this.#ungranted = 0;
    this.#session.mux.consumed(this.streamId, bytes);
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    const mux = this.#session.mux;
    if (mux.has(this.streamId)) mux.reset(this.streamId);
    this.#session.forget(this.streamId);
    const pendingDone = this.#pendingDone;
    this.#pending = null;
    this.#pendingDone = null;
    pendingDone?.(error ?? new Error("stream reset"));
    done(error);
  }

  /** Node's HTTP client calls these on its socket; a stream has no TCP options to set. */
  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setTimeout(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  /** Granted back as the reader takes it, so a slow reader slows the sender. */
  deliver(data: Buffer): void {
    if (this.push(data)) this.#session.mux.consumed(this.streamId, data.length);
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
      if (!mux.has(this.streamId) || this.#session.closed) return void this.destroy(new Error("stream reset"));
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

export class MuxSession {
  readonly mux: Mux;
  readonly #transport: FrameTransport;
  readonly #hooks: MuxHooks;
  readonly #streams = new Map<number, MuxStream>();
  #drainWaiters: Array<() => void> = [];
  #closed = false;

  constructor(role: Role, transport: FrameTransport, hooks: MuxHooks) {
    this.#transport = transport;
    this.#hooks = hooks;
    this.mux = new Mux(role, {
      send: (frame) => this.#send(frame),
      opened: (streamId) => this.#incoming(streamId),
      data: (streamId, data) => this.#streams.get(streamId)?.deliver(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
      ended: (streamId) => this.#streams.get(streamId)?.remoteEnded(),
      reset: (streamId) => {
        const stream = this.#streams.get(streamId);
        this.#streams.delete(streamId);
        stream?.remoteReset();
      },
      writable: (streamId) => this.#streams.get(streamId)?.flush(),
      goAway: (code) => {
        if (code !== GO_AWAY.normal) this.#hooks.failed(`the peer went away (${code})`);
      },
      pong: (value) => this.#hooks.pong?.(value),
    });
  }

  get closed(): boolean {
    return this.#closed;
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

  /** One binary message from the peer: exactly one frame. */
  receive(message: Uint8Array): void {
    if (this.#closed) return;
    try {
      this.mux.receive(decodeFrame(message));
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      this.mux.protocolError();
      this.#hooks.failed(error.reason);
    }
  }

  /** The opening side. */
  openStream(): MuxStream {
    if (this.#closed) throw new YamuxError("closed");
    const streamId = this.mux.open();
    const stream = new MuxStream(this, streamId);
    this.#streams.set(streamId, stream);
    return stream;
  }

  ping(value: number): void {
    if (!this.#closed) this.mux.ping(value);
  }

  /** A planned close: GoAway first, so the peer knows it isn't an error. */
  goAway(): void {
    if (!this.#closed) this.mux.goAway(GO_AWAY.normal);
  }

  /** The connection is gone: every stream ends with a reset. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.mux.closeAll();
    for (const stream of this.#streams.values()) stream.remoteReset();
    this.#streams.clear();
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const waiter of waiters) waiter();
  }

  #send(frame: Frame): void {
    if (!this.#closed) this.#transport.send(encodeFrame(frame));
  }

  #incoming(streamId: number): void {
    const stream = new MuxStream(this, streamId);
    this.#streams.set(streamId, stream);
    if (!this.#hooks.incoming) return void stream.destroy();
    this.#hooks.incoming(stream, () => {
      if (!stream.destroyed && !this.#closed) this.mux.accept(streamId);
    });
  }
}
