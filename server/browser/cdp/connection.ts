import { CdpProtocolError, DriverError } from "./errors.ts";
import { methodRefusal, type SendFlags, type SessionKind } from "./policy.ts";
import type { CdpTransport } from "./transport.ts";

export type Params = Record<string, unknown>;
export type EventListener = (params: Params) => void;

export interface SendOptions extends SendFlags {
  /** 0 waits forever; the default is the connection's. */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  session: CdpSession;
  resolve: (result: Params) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Message {
  id?: number;
  method?: string;
  params?: Params;
  result?: Params;
  error?: { code?: number; message?: string; data?: string };
  sessionId?: string;
}

export function sessionKindOf(targetType: string): SessionKind {
  if (targetType === "page") return "page";
  if (targetType === "iframe") return "frame";
  if (targetType === "worker" || targetType === "service_worker" || targetType === "shared_worker") return "worker";
  return "other";
}

/** Ids, flat sessions, timeouts and the method guard over one transport. */
export class CdpConnection {
  readonly root: CdpSession;
  readonly #transport: CdpTransport;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #sessions = new Map<string, CdpSession>();
  readonly #closeListeners = new Set<(reason: string) => void>();
  #nextId = 0;
  #closeReason: string | null = null;

  constructor(transport: CdpTransport, { defaultTimeoutMs = 30_000, firstId = 0 }: { defaultTimeoutMs?: number; firstId?: number } = {}) {
    this.#transport = transport;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#nextId = firstId;
    this.root = new CdpSession(this, null, "browser");
    transport.onMessage((text) => this.#receive(text));
    transport.onClose((reason) => this.#closed(reason));
  }

  get closed(): boolean {
    return this.#closeReason !== null;
  }

  get closeReason(): string | null {
    return this.#closeReason;
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.#closeReason !== null) {
      listener(this.#closeReason);
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  session(sessionId: string): CdpSession | undefined {
    return this.#sessions.get(sessionId);
  }

  close(): void {
    this.#transport.close();
    this.#closed("closed by the driver");
  }

  /** Sessions only send through here. */
  dispatch(session: CdpSession, method: string, params: Params, options: SendOptions): Promise<Params> {
    const refusal = methodRefusal(session.kind, method, params, options);
    if (refusal) return Promise.reject(new DriverError("forbidden-method", refusal, { method }));
    if (this.#closeReason !== null) return Promise.reject(new DriverError("closed", `The browser connection is closed (${this.#closeReason}).`));
    if (session.detached) return Promise.reject(new DriverError("closed", `The ${session.kind} that ${method} was sent to is gone.`));
    const id = ++this.#nextId;
    const message = session.id === null ? { id, method, params } : { id, method, params, sessionId: session.id };
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    return new Promise<Params>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.#pending.delete(id);
          reject(new DriverError("timeout", `${method} got no answer within ${timeoutMs} ms.`, { method, unanswered: true }));
        }, timeoutMs)
        : undefined;
      this.#pending.set(id, { method, session, resolve, reject, timer });
      try {
        this.#transport.send(JSON.stringify(message));
      } catch (error) {
        this.#pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  #receive(text: string): void {
    let message: Message;
    try { message = JSON.parse(text) as Message; } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.data ? ` (${message.error.data})` : "";
        pending.reject(new CdpProtocolError(pending.method, `${message.error.message ?? "failed"}${detail}`, message.error.code));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const session = message.sessionId === undefined ? this.root : this.#sessions.get(message.sessionId);
    if (!session) return;
    const params = message.params ?? {};
    // A child's events can follow its attach event in the same read: it must exist before anyone hears of it.
    if (message.method === "Target.attachedToTarget") this.#attach(params, session);
    session.emit(message.method, params);
    if (message.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") this.#detach(params.sessionId);
  }

  #attach(params: Params, parent: CdpSession): void {
    const sessionId = params.sessionId;
    const info = params.targetInfo as { type?: unknown } | undefined;
    if (typeof sessionId !== "string" || this.#sessions.has(sessionId)) return;
    this.#sessions.set(sessionId, new CdpSession(this, sessionId, sessionKindOf(typeof info?.type === "string" ? info.type : ""), parent));
  }

  #detach(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.markDetached();
    for (const [id, pending] of this.#pending) {
      if (pending.session !== session) continue;
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new DriverError("closed", `The ${session.kind} that ${pending.method} was sent to is gone.`));
    }
  }

  #closed(reason: string): void {
    if (this.#closeReason !== null) return;
    this.#closeReason = reason;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new DriverError("closed", `The browser connection closed (${reason}) before ${pending.method} answered.`));
    }
    for (const session of this.#sessions.values()) session.markDetached();
    this.#sessions.clear();
    this.root.markDetached();
    for (const listener of this.#closeListeners) {
      try { listener(reason); } catch {}
    }
    this.#closeListeners.clear();
  }
}

/** One flat session: the browser itself (id null), a page, a frame or a worker. */
export class CdpSession {
  readonly connection: CdpConnection;
  readonly id: string | null;
  readonly kind: SessionKind;
  readonly parent: CdpSession | null;
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #detachListeners = new Set<() => void>();
  #detached = false;

  constructor(connection: CdpConnection, id: string | null, kind: SessionKind, parent: CdpSession | null = null) {
    this.connection = connection;
    this.id = id;
    this.kind = kind;
    this.parent = parent;
  }

  get detached(): boolean {
    return this.#detached;
  }

  send<T = Params>(method: string, params: Params = {}, options: SendOptions = {}): Promise<T> {
    return this.connection.dispatch(this, method, params, options) as Promise<T>;
  }

  on(method: string, listener: EventListener): () => void {
    let set = this.#listeners.get(method);
    if (!set) this.#listeners.set(method, set = new Set());
    set.add(listener);
    return () => set.delete(listener);
  }

  onDetach(listener: () => void): () => void {
    if (this.#detached) {
      listener();
      return () => {};
    }
    this.#detachListeners.add(listener);
    return () => this.#detachListeners.delete(listener);
  }

  /** The next `method` event that `match` accepts; rejects on timeout or when the session goes. */
  waitFor(method: string, { match = () => true, timeoutMs = 30_000 }: { match?: (params: Params) => boolean; timeoutMs?: number } = {}): Promise<Params> {
    if (this.#detached) return Promise.reject(new DriverError("closed", `The ${this.kind} closed while waiting for ${method}.`));
    return new Promise<Params>((resolve, reject) => {
      const done = () => {
        off();
        offDetach();
        clearTimeout(timer);
      };
      const off = this.on(method, (params) => {
        if (!match(params)) return;
        done();
        resolve(params);
      });
      const offDetach = this.onDetach(() => {
        done();
        reject(new DriverError("closed", `The ${this.kind} closed while waiting for ${method}.`));
      });
      const timer = setTimeout(() => {
        done();
        reject(new DriverError("timeout", `${method} did not happen within ${timeoutMs} ms.`, { method }));
      }, timeoutMs);
    });
  }

  emit(method: string, params: Params): void {
    const set = this.#listeners.get(method);
    if (!set) return;
    for (const listener of set) {
      try { listener(params); } catch {}
    }
  }

  markDetached(): void {
    if (this.#detached) return;
    this.#detached = true;
    for (const listener of this.#detachListeners) {
      try { listener(); } catch {}
    }
    this.#detachListeners.clear();
  }
}
