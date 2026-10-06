import { mkdirSync } from "node:fs";
import { TLSMode, type Inkbox, type Tunnel } from "@inkbox/sdk";
import { connect } from "@inkbox/sdk/tunnels/connect";
import { inkboxPublicUrl, InkboxSetupError, InkboxProvider, INKBOX_TUNNEL_ZONE, type InkboxTunnelMetadata } from "./inkbox-provider.ts";

export interface InkboxTunnel {
  readonly isConnected: boolean;
  wait(): Promise<void>;
  close(): Promise<void>;
}
export interface InkboxTunnelOptions {
  apiKey: string; identityId: string; handle: string; stateDir: string; port: number;
  fetch?: typeof fetch;
  active(): boolean;
}
/** The only network surface exposed by the SDK tunnel. Never a general app proxy. */
export function createInkboxTunnelHandler(options: { handle: string; port: number; active(): boolean; fetch?: typeof fetch }) {
  const origin = inkboxPublicUrl(options.handle);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid message receiver port");
  const destination = `http://127.0.0.1:${options.port}/inkbox`;
  return async (req: Request, signal?: AbortSignal): Promise<Response> => {
    const response = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
    if (!options.active()) return response(503);
    const url = new URL(req.url);
    if (url.origin !== origin || url.pathname !== "/inkbox" || url.search || req.method !== "POST" || req.headers.has("upgrade")) return response(404);
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const name of ["x-inkbox-request-id", "x-inkbox-timestamp", "x-inkbox-signature"]) {
      const value = req.headers.get(name); if (!value) return response(403); headers.set(name, value);
    }
    if (req.headers.has("content-encoding")) headers.set("content-encoding", req.headers.get("content-encoding")!);
    const length = req.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > 128 * 1024)) return response(413);
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = req.body?.getReader();
      if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 128 * 1024) { await reader.cancel(); return response(413); } chunks.push(part.value); }
      if (!options.active()) return response(503);
      const result = await (options.fetch ?? fetch)(destination, { method: "POST", redirect: "error", headers, body: Buffer.concat(chunks),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]) });
      await result.body?.cancel();
      return response([202, 400, 403, 409, 413, 429, 503].includes(result.status) ? result.status : 503);
    } catch { return response(503); }
  };
}
export async function openInkboxTunnel(options: InkboxTunnelOptions): Promise<InkboxTunnel> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const handler = createInkboxTunnelHandler(options);
  const provider = new InkboxProvider(options.apiKey, options.fetch);
  const model = (raw: InkboxTunnelMetadata): Tunnel => ({
    id: raw.id, tunnelName: raw.tunnel_name, agentIdentityId: raw.agent_identity_id,
    publicHost: raw.public_host, zone: INKBOX_TUNNEL_ZONE, tlsMode: TLSMode.EDGE,
    status: raw.status, currentlyConnected: false, organizationId: null, certPem: null,
    certFingerprintSha256: null, certExpiresAt: null, lastConnectedAt: null,
    lastConnectedIpAddr: null, lastDisconnectedAt: null, metadata: {},
    createdAt: new Date(0), updatedAt: new Date(0),
  });
  const get = async (id: string) => {
    if (!options.active()) throw new InkboxSetupError("The message connection was stopped.", 503);
    const result = model(await provider.getTunnel(id, options.identityId, options.handle));
    if (!options.active()) throw new InkboxSetupError("The message connection was stopped.", 503);
    return result;
  };
  // Pinned SDK 0.7.14 connect reads only _apiKey and tunnels.get/list.
  // Supply that narrow surface rather than constructing its default client:
  // the default HTTP transport follows redirects, and construction can unlock
  // an ambient vault key. Every control-plane read uses our bounded transport.
  const client = {
    _apiKey: options.apiKey,
    tunnels: {
      get,
      list: async () => {
        if (!options.active()) throw new InkboxSetupError("The message connection was stopped.", 503);
        const identity = await provider.getIdentity(options.handle);
        if (identity.id !== options.identityId) throw new InkboxSetupError("Inkbox returned a different identity.", 502);
        return [await get(identity.tunnel.id)];
      },
    },
  } as unknown as Inkbox;
  const pending = connect(client, { name: options.handle, stateDir: options.stateDir, handler: (req, ctx) => handler(req, ctx.signal),
    dataPlaneZone: INKBOX_TUNNEL_ZONE, installSignalHandlers: false, maxInboundBodyBytes: 128 * 1024, maxResponseBytes: 1024, poolSize: 1 });
  let expired = false; let timer: ReturnType<typeof setTimeout> | undefined;
  void pending.then(listener => { if (expired || !options.active()) void listener.close().catch(() => {}); }, () => {});
  try {
    const listener = await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new InkboxSetupError("The message connection timed out. Try reconnecting.", 503)); }, 30_000);
      timer.unref();
    })]);
    if (listener.publicUrl !== inkboxPublicUrl(options.handle) || !options.active()) {
      await listener.close(); throw new InkboxSetupError("The message connection could not be started.", 503);
    }
    return listener;
  } catch (error) {
    if (error instanceof InkboxSetupError) throw error;
    throw new InkboxSetupError("The message connection could not be started. Check Inkbox and reconnect.", 503);
  } finally { clearTimeout(timer); }
}
