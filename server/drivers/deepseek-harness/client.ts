import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";

import {
  dshClientResponseSchema,
  dshClientRequestSchema,
  dshJsonValueSchema,
  dshReceiptSchema,
  dshServerRequestSchema,
  dshServerResponseSchema,
  dshStreamRequestSchema,
  dshUnaryValueSchema,
  isDshApiMethod,
  type DshReceipt,
  type DshJsonValue,
  type DshRpcResult,
  type DshServerRequest,
} from "./protocol.ts";

const MAX_JSON_BYTES = 1_000_000;
const RECONNECT_BASE_MS = 25;
const RECONNECT_MAX_MS = 500;
const OPERATION_TIMEOUT_MS = 8_000;
const STREAM_OPEN_TIMEOUT_MS = 3_000;
const PAIRED_LOOPBACK_ONLY_METHODS = new Set([
  "host.pickDirectory",
  "host.openPath",
  "agentPreset.read",
  "agentPreset.copy",
  "agentPreset.openDocument",
  "agentPreset.remove",
  // Older DSH builds called this domain agentPresets; the privileged verbs remain equivalent.
  "agentPresets.read",
  "agentPresets.copy",
  "agentPresets.openDocument",
  "agentPresets.remove",
]);

export interface DshApiClientOptions {
  baseUrl: string;
  transport: "direct" | "paired";
  deviceCookie?: string;
  /** Bound request and body reads; tests may lower this for blackholed hosts. */
  timeoutMs?: number;
  /** Bound the strict mux+host readiness handshake. */
  streamOpenTimeoutMs?: number;
}

export interface DshUnaryResponse<T> {
  rpcId: string;
  value: T;
}

export class DshRpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`DSH request was rejected (${code})`);
    this.code = code;
    this.name = "DshRpcError";
  }
}

export class DshTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshTransportError";
  }
}

type StreamKind = "mux" | "host";
type StreamListener = (frame: DshServerRequest) => void;
export type DshStreamHealth = { kind: StreamKind; state: "connected" | "reconnecting"; generation: number };
type HealthListener = (health: DshStreamHealth) => void;

interface StreamState {
  socket?: WebSocket;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  openTimer?: ReturnType<typeof setTimeout>;
  attempts: number;
  generation: number;
  connected: boolean;
}

function newStreamState(): StreamState {
  return { attempts: 0, generation: 0, connected: false };
}

interface ReadinessWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DshApiClient {
  private readonly baseUrl: URL;
  private readonly transport: "direct" | "paired";
  private readonly pathPrefix: "/api" | "/remote/api";
  private readonly headers: Record<string, string>;
  private readonly listeners = { mux: new Set<StreamListener>(), host: new Set<StreamListener>() };
  private readonly healthListeners = new Set<HealthListener>();
  private readonly streams = { mux: newStreamState(), host: newStreamState() };
  private readonly operations = new Map<AbortController, ReturnType<typeof setTimeout>>();
  private readonly readinessWaiters = new Set<ReadinessWaiter>();
  private readonly timeoutMs: number;
  private readonly streamOpenTimeoutMs: number;
  private closed = false;

  constructor(options: DshApiClientOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new DshTransportError("DSH base URL is invalid");
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new DshTransportError("DSH base URL must use HTTP or HTTPS");
    }
    if (options.transport === "paired" && !validCookie(options.deviceCookie)) {
      throw new DshTransportError("DSH paired transport requires a device cookie");
    }
    this.baseUrl = baseUrl;
    this.transport = options.transport;
    this.pathPrefix = options.transport === "paired" ? "/remote/api" : "/api";
    this.headers = options.transport === "paired" ? { Cookie: options.deviceCookie! } : {};
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : OPERATION_TIMEOUT_MS;
    this.streamOpenTimeoutMs = options.streamOpenTimeoutMs && options.streamOpenTimeoutMs > 0 ? options.streamOpenTimeoutMs : STREAM_OPEN_TIMEOUT_MS;
  }

  async unary<T extends DshJsonValue>(method: string, payload: DshJsonValue): Promise<DshUnaryResponse<T>> {
    if (!isDshApiMethod(method)) throw new DshTransportError("DSH API method is invalid");
    if (this.transport === "paired" && pairedMethodIsLoopbackOnly(method)) {
      throw new DshTransportError("DSH method is not available through paired transport");
    }
    const rpcId = randomUUID();
    const request = dshClientRequestSchema.safeParse({ type: "client-request", rpcId, method, payload });
    if (!request.success) throw new DshTransportError("DSH request envelope was invalid");
    const body = JSON.stringify(request.data);
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new DshTransportError("DSH request exceeds the size limit");
    const controller = this.operationController();
    let response: Response;
    try {
      response = await fetch(this.endpoint(method), {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body,
        signal: controller.signal,
      });
    } catch {
      this.finishOperation(controller);
      throw new DshTransportError("DSH request could not reach the host");
    }
    try {
      if (!response.ok) throw new DshTransportError(`DSH request failed with HTTP ${response.status}`);
      const parsed = dshServerResponseSchema.safeParse(await boundedJson(response));
      if (!parsed.success) throw new DshTransportError("DSH response envelope was invalid");
      if (parsed.data.rpcId !== rpcId) throw new DshTransportError("DSH response rpc id did not match request");
      if (!parsed.data.result.ok) throw new DshRpcError(parsed.data.result.error.code);
      const valueSchema = dshUnaryValueSchema(method);
      const value = valueSchema?.safeParse(parsed.data.result.value);
      if (value && !value.success) throw new DshTransportError("DSH response value was invalid");
      // SAFETY: the generic caller owns T; the bounded wire parser established this is JSON data.
      return { rpcId, value: (value?.data ?? parsed.data.result.value) as T };
    } catch (error) {
      if (error instanceof DshTransportError || error instanceof DshRpcError) throw error;
      throw new DshTransportError("DSH request could not reach the host");
    } finally {
      this.finishOperation(controller);
    }
  }

  async respond(rpcId: string, result: DshRpcResult): Promise<DshReceipt> {
    const parsed = dshClientResponseSchema.safeParse({ type: "client-response", rpcId, result });
    if (!parsed.success) throw new DshTransportError("DSH response envelope was invalid");
    const body = JSON.stringify(parsed.data);
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new DshTransportError("DSH response exceeds the size limit");
    const controller = this.operationController();
    let response: Response;
    try {
      response = await fetch(this.endpoint("respond"), {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body,
        signal: controller.signal,
      });
    } catch {
      this.finishOperation(controller);
      throw new DshTransportError("DSH response could not reach the host");
    }
    try {
      if (!response.ok) throw new DshTransportError(`DSH response failed with HTTP ${response.status}`);
      const receipt = dshReceiptSchema.safeParse(await boundedJson(response));
      if (!receipt.success) throw new DshTransportError("DSH response receipt was invalid");
      return receipt.data;
    } catch (error) {
      if (error instanceof DshTransportError) throw error;
      throw new DshTransportError("DSH response could not reach the host");
    } finally {
      this.finishOperation(controller);
    }
  }

  subscribeMux(listener: StreamListener): () => void {
    return this.subscribe("mux", listener);
  }

  subscribeHost(listener: StreamListener): () => void {
    return this.subscribe("host", listener);
  }

  /** Strict readiness: unary startup may proceed only while both physical downlinks are open. */
  waitForStreamsOpen(): Promise<void> {
    if (this.closed) return Promise.reject(new DshTransportError("DSH client is closed"));
    if (this.streams.mux.connected && this.streams.host.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadinessWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => this.handleStreamOpenTimeout(), this.streamOpenTimeoutMs),
      };
      waiter.timer.unref?.();
      this.readinessWaiters.add(waiter);
      this.settleReadiness();
    });
  }

  /** Sanitized state only: consumers never receive an upstream error body. */
  subscribeHealth(listener: HealthListener): () => void {
    if (this.closed) throw new DshTransportError("DSH client is closed");
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortOperations();
    for (const kind of ["mux", "host"] as const) this.stopStream(kind);
  }

  /** Used only for provider-wide teardown; it leaves streams reusable until close(). */
  abortOperations(): void {
    for (const [operation, timer] of this.operations) {
      clearTimeout(timer);
      operation.abort();
    }
    this.operations.clear();
    this.rejectReadiness(new DshTransportError("DSH event stream wait was aborted"));
  }

  private subscribe(kind: StreamKind, listener: StreamListener): () => void {
    if (this.closed) throw new DshTransportError("DSH client is closed");
    this.listeners[kind].add(listener);
    this.connect(kind);
    return () => {
      this.listeners[kind].delete(listener);
      if (!this.listeners[kind].size) this.stopStream(kind);
    };
  }

  private connect(kind: StreamKind): void {
    const state = this.streams[kind];
    if (this.closed || !this.listeners[kind].size || state.socket || state.reconnectTimer) return;
    const socket = new WebSocket(this.webSocketEndpoint(kind), { headers: this.headers, maxPayload: MAX_JSON_BYTES });
    state.socket = socket;
    state.generation++;
    const generation = state.generation;
    state.openTimer = setTimeout(() => {
      if (state.socket === socket && !state.connected) this.handleStreamOpenTimeout();
    }, this.streamOpenTimeoutMs);
    state.openTimer.unref?.();
    socket.once("open", () => {
      if (state.socket === socket) {
        if (state.openTimer) clearTimeout(state.openTimer);
        state.openTimer = undefined;
        state.attempts = 0;
        state.connected = true;
        this.emitHealth(kind, "connected", generation);
        this.settleReadiness();
      }
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || rawDataByteLength(data) > MAX_JSON_BYTES) return;
      const frame = parseStreamFrame(kind, rawDataText(data));
      if (!frame) return;
      for (const listener of this.listeners[kind]) listener(frame);
    });
    socket.on("error", () => {
      // The close handler owns retries, so a failed connect cannot schedule twice.
    });
    socket.once("close", () => {
      if (state.socket !== socket) return;
      if (state.openTimer) clearTimeout(state.openTimer);
      state.openTimer = undefined;
      state.socket = undefined;
      state.connected = false;
      this.emitHealth(kind, "reconnecting", generation);
      this.scheduleReconnect(kind);
    });
  }

  private scheduleReconnect(kind: StreamKind): void {
    const state = this.streams[kind];
    if (this.closed || !this.listeners[kind].size || state.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.attempts, RECONNECT_MAX_MS);
    state.attempts = Math.min(state.attempts + 1, 10);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      this.connect(kind);
    }, delay);
    state.reconnectTimer.unref?.();
  }

  private stopStream(kind: StreamKind): void {
    const state = this.streams[kind];
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.openTimer) clearTimeout(state.openTimer);
    state.reconnectTimer = undefined;
    state.openTimer = undefined;
    const socket = state.socket;
    state.socket = undefined;
    state.connected = false;
    socket?.terminate();
  }

  private handleStreamOpenTimeout(): void {
    if (this.closed) return;
    this.rejectReadiness(new DshTransportError("DSH event streams did not open"));
    const reconnect: StreamKind[] = [];
    for (const kind of ["mux", "host"] as const) {
      const state = this.streams[kind];
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.openTimer) clearTimeout(state.openTimer);
      state.reconnectTimer = undefined;
      state.openTimer = undefined;
      const socket = state.socket;
      const lostGeneration = Boolean(socket) || state.connected;
      state.socket = undefined;
      state.connected = false;
      socket?.terminate();
      if (lostGeneration) this.emitHealth(kind, "reconnecting", state.generation);
      if (this.listeners[kind].size) reconnect.push(kind);
    }
    for (const kind of reconnect) this.scheduleReconnect(kind);
  }

  private settleReadiness(): void {
    if (!this.streams.mux.connected || !this.streams.host.connected) return;
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.readinessWaiters.clear();
  }

  private rejectReadiness(error: Error): void {
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readinessWaiters.clear();
  }

  private endpoint(method: string): string {
    return new URL(`${this.pathPrefix}/${method}`, this.baseUrl).toString();
  }

  private operationController(): AbortController {
    if (this.closed) throw new DshTransportError("DSH client is closed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    this.operations.set(controller, timer);
    return controller;
  }

  private finishOperation(controller: AbortController): void {
    const timer = this.operations.get(controller);
    if (timer) clearTimeout(timer);
    this.operations.delete(controller);
  }

  private emitHealth(kind: StreamKind, state: DshStreamHealth["state"], generation: number): void {
    for (const listener of this.healthListeners) listener({ kind, state, generation });
  }

  private webSocketEndpoint(kind: StreamKind): string {
    const endpoint = new URL(`${this.pathPrefix}/events.${kind}`, this.baseUrl);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return endpoint.toString();
  }
}

const cookieSchema = z.string().min(1).max(4_096).regex(/^[^\r\n]+$/);

function validCookie(value: string | undefined): value is string {
  return cookieSchema.safeParse(value).success;
}

async function boundedJson(response: Response): Promise<DshJsonValue> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_JSON_BYTES) {
    void response.body?.cancel();
    throw new DshTransportError("DSH response exceeds the size limit");
  }
  if (!response.body) throw new DshTransportError("DSH response was not valid JSON");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new DshTransportError("DSH response exceeds the size limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = dshJsonValueSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) throw new DshTransportError("DSH response was not valid JSON");
    return parsed.data;
  } catch {
    throw new DshTransportError("DSH response was not valid JSON");
  }
}

function parseStreamFrame(kind: StreamKind, text: string): DshServerRequest | null {
  try {
    const parsed = dshStreamRequestSchema(kind).safeParse(JSON.parse(text));
    return parsed.success ? dshServerRequestSchema.parse(parsed.data) : null;
  } catch {
    return null;
  }
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  return data.byteLength;
}

function rawDataText(data: RawData): string {
  return Array.isArray(data) ? Buffer.concat(data).toString() : data.toString();
}

function pairedMethodIsLoopbackOnly(method: string): boolean {
  return method.startsWith("settings.")
    || method.startsWith("credentials.")
    || method === "llm.discoverModels"
    || PAIRED_LOOPBACK_ONLY_METHODS.has(method);
}
