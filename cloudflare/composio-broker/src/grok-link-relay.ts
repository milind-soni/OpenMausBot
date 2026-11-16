import { fromDesktopSchema, GROK_LINK_ANSWER_MAX, GROK_LINK_IN_FLIGHT, GROK_LINK_REPLACED, type LinkManifest } from "../../../shared/grok-link";
import { JSON_HEADERS, json } from "./common";

export interface RelaySocket { send(text: string): void; close(code: number, reason: string): void }
export interface RelayStore { read(): Promise<LinkManifest | null>; write(manifest: LinkManifest): Promise<void>; clear(): Promise<void> }
export interface RelayLimits { pickupMs: number; answerMs: number; inFlight: number }

type RpcId = string | number;
interface Pending { socket: RelaySocket; requestId: RpcId; got(): void; settle(response: Response): void }

const rpcResult = (id: RpcId, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId | null, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);

/** One Grok Bot link: the desktop's socket and the calls waiting on it. It answers the MCP handshake from the manifest
 *  the desktop sent, and relays each tools/call to the desktop. No Workers APIs, so it runs under plain vitest. */
export class LinkRelay {
  private manifest: LinkManifest | null | undefined;
  private current: RelaySocket | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly store: RelayStore,
    /** The open sockets, oldest first: what is left of them after the object slept. */
    private readonly sockets: () => RelaySocket[],
    private readonly limits: RelayLimits = { pickupMs: 5_000, answerMs: 40_000, inFlight: GROK_LINK_IN_FLIGHT },
  ) {}

  /** The newest socket wins; older ones are closed as replaced. */
  attach(socket: RelaySocket): void {
    for (const other of this.sockets()) if (other !== socket) this.drop(other, GROK_LINK_REPLACED, "replaced");
    this.current = socket;
  }

  async received(socket: RelaySocket, text: string): Promise<void> {
    let frame;
    try {
      if (text.length > GROK_LINK_ANSWER_MAX) throw new Error("frame too large");
      frame = fromDesktopSchema.parse(JSON.parse(text));
    } catch {
      return this.drop(socket, 4002, "unreadable frame");
    }
    if (frame.t === "hello") {
      this.manifest = frame.manifest;
      return this.store.write(frame.manifest);
    }
    const call = this.pending.get(frame.id);
    if (!call || call.socket !== socket) return;
    if (frame.t === "got") return call.got();
    call.settle(frame.body === undefined ? new Response(null, { status: frame.status, headers: { "cache-control": "no-store" } })
      : new Response(JSON.stringify(frame.body), { status: frame.status, headers: JSON_HEADERS }));
  }

  /** The socket is gone: every call sent on it gets the offline answer now. */
  closed(socket: RelaySocket): void {
    if (this.current === socket) this.current = null;
    const offline = this.manifest?.offline;
    for (const call of [...this.pending.values()]) {
      if (call.socket === socket) call.settle(offline ? rpcResult(call.requestId, offline) : json({ error: "service unavailable" }, 503));
    }
  }

  /** The answer to one POST body from Grok Bot. */
  async call(body: string): Promise<Response> {
    let message: { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } | null };
    try {
      message = JSON.parse(body);
    } catch {
      return rpcError(null, -32700, "Parse error", 400);
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
      return rpcError(null, -32600, "Send one JSON-RPC 2.0 request", 400);
    }
    if (message.id === undefined) return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
    if (typeof message.id !== "string" && typeof message.id !== "number") return rpcError(null, -32600, "Send one JSON-RPC 2.0 request", 400);
    const id = message.id;
    this.manifest ??= await this.store.read();
    const manifest = this.manifest;
    if (!manifest) return json({ error: "service unavailable" }, 503, { "retry-after": "5" });
    switch (message.method) {
      case "initialize": {
        const asked = message.params?.protocolVersion;
        return rpcResult(id, { ...manifest.initialize, protocolVersion: typeof asked === "string" && manifest.versions.includes(asked) ? asked : manifest.versions[0] });
      }
      case "ping": return rpcResult(id, {});
      case "tools/list": return rpcResult(id, manifest.tools);
      case "tools/call": return this.relay(id, body, manifest);
      default: return rpcError(id, -32601, "Method not found");
    }
  }

  async purge(): Promise<void> {
    for (const socket of this.sockets()) this.drop(socket, 4004, "link turned off");
    this.manifest = null;
    await this.store.clear();
  }

  private relay(requestId: RpcId, body: string, manifest: LinkManifest): Promise<Response> {
    const socket = this.current ?? this.sockets().at(-1) ?? null;
    if (!socket) return Promise.resolve(rpcResult(requestId, manifest.offline));
    if (this.pending.size >= this.limits.inFlight) {
      return Promise.resolve(rpcError(requestId, -32000, "Too many calls at once on this link. Wait a few seconds, then call again.", 429));
    }
    this.current = socket;
    const callId = crypto.randomUUID();
    return new Promise<Response>((resolve) => {
      const pickup = setTimeout(() => this.drop(socket, 4003, "no receipt"), this.limits.pickupMs);
      const late = setTimeout(() => settle(rpcResult(requestId, manifest.late)), this.limits.answerMs);
      const settle = (response: Response) => {
        clearTimeout(pickup);
        clearTimeout(late);
        this.pending.delete(callId);
        resolve(response);
      };
      this.pending.set(callId, { socket, requestId, got: () => clearTimeout(pickup), settle });
      try {
        socket.send(`{"t":"call","id":"${callId}","message":${body}}`);
      } catch {
        this.drop(socket, 4003, "send failed");
      }
    });
  }

  private drop(socket: RelaySocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
    this.closed(socket);
  }
}
