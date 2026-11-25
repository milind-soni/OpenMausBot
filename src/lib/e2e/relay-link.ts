// A web page's way to a `serve --relay` computer from anywhere: an end-to-end encrypted session through MausBot Relay
// that carries plain HTTP to the server's own request handler (server/phone-relay.ts), as a session of its own.
import { fromB64u, type Bytes } from "./bytes.ts";
import { admission, credentialHash, keyId, psk } from "./credentials.ts";
import { streamFetch, type StreamRequest } from "./http.ts";
import { dialRelay, type PhoneSession } from "./session.ts";

/** As companion/src/e2e/descriptor.ts. */
const RELAY_HOST = /^relay[1-9][0-9]?\.openmausbot\.com$/;
const MAX_RELAY_NODES = 4;
const PUBLIC_KEY_BYTES = 65;
const HOST_ID_BYTES = 16;
const APP = "openmausbot-web/1";

export interface RelayRoute {
  remoteStatic: Bytes;
  hostId: Bytes;
  /** The relay nodes' phone URLs, best first. */
  urls: string[];
}

export interface RelayRouteOptions {
  /** Test-only: dial a node through this URL instead of `wss://<node>/v1/phone`. */
  nodeUrl?: (node: string) => string;
}

/** The relay half of an `e2e` descriptor (the pairing link's, decoded, or the pair reply's), or null when it names no
 * relay or any part is malformed. The key's point is checked by the handshake itself. */
export function relayRoute(descriptor: unknown, options: RelayRouteOptions = {}): RelayRoute | null {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  const { v, k, h, r } = descriptor as Record<string, unknown>;
  if (v !== 1 || typeof k !== "string" || typeof h !== "string" || !Array.isArray(r)) return null;
  const remoteStatic = fromB64u(k);
  const hostId = fromB64u(h);
  if (remoteStatic?.length !== PUBLIC_KEY_BYTES || hostId?.length !== HOST_ID_BYTES) return null;
  if (r.length < 1 || r.length > MAX_RELAY_NODES || !r.every((node) => typeof node === "string" && RELAY_HOST.test(node))) return null;
  const nodeUrl = options.nodeUrl ?? ((node: string) => `wss://${node}/v1/phone`);
  return { remoteStatic, hostId, urls: r.map(nodeUrl) };
}

/** A session keyed by `token`: the pairing credential while pairing, the device's own session token after. */
async function open(route: RelayRoute, token: string): Promise<PhoneSession> {
  const hash = await credentialHash(token);
  return dialRelay({
    urls: route.urls, hostId: route.hostId, remoteStatic: route.remoteStatic, app: APP,
    psk: await psk(hash, await keyId(route.remoteStatic)), adm: await admission(hash, route.hostId),
  });
}

export class RelayPairError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayPairError";
    this.status = status;
  }
}

export interface RelayPairing {
  /** The device's own session token: it keys the relay session and signs every request. */
  token: string;
  serverName: string;
  /** The computer's descriptor for this device, to keep instead of the pairing link's. */
  descriptor: unknown;
}

/** Redeems a pairing link's credential through the relay, as the MausBot phone app does. */
export async function pairThroughRelay(route: RelayRoute, credential: string, deviceName: string): Promise<RelayPairing> {
  const session = await open(route, credential);
  try {
    const reply = await streamFetch(() => session.open(), {
      method: "POST", path: "/api/pair", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential, deviceName }),
    });
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null;
    if (!reply.ok || typeof body?.token !== "string") {
      throw new RelayPairError(reply.status, typeof body?.error === "string" ? body.error : `pairing failed (${reply.status})`);
    }
    return { token: body.token, serverName: typeof body.serverName === "string" ? body.serverName : "", descriptor: body.e2e };
  } finally {
    session.shutdown();
  }
}

export type RelayRequest = Omit<StreamRequest, "path">;

/** One paired device's requests, each on its own stream of one shared session. The session is dialed on the first
 * request and again on the first request after it closes; requests made while it dials share that dial. */
export class RelayLink {
  readonly #route: RelayRoute;
  readonly #token: string;
  #session: Promise<PhoneSession> | null = null;
  #closed = false;

  constructor(route: RelayRoute, token: string) {
    this.#route = route;
    this.#token = token;
  }

  async fetch(path: string, request: RelayRequest = {}): Promise<Response> {
    const { signal } = request;
    signal?.throwIfAborted();
    const session = await (signal ? untilAborted(this.#live(), signal) : this.#live());
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    return streamFetch(() => session.open(), { ...request, path, headers });
  }

  /** Ends the session; later requests are refused. */
  close(): void {
    this.#closed = true;
    void this.#session?.then((session) => session.shutdown(), () => {});
    this.#session = null;
  }

  #live(): Promise<PhoneSession> {
    if (this.#closed) return Promise.reject(new Error("relay link closed"));
    if (this.#session) return this.#session;
    const dialing = open(this.#route, this.#token);
    const forget = () => {
      if (this.#session === dialing) this.#session = null;
    };
    this.#session = dialing;
    dialing.then((session) => void session.closed.then(forget), forget);
    return dialing;
  }
}

/** `promise`, or `signal`'s reason as soon as it aborts; the promise itself goes on for anyone else waiting on it. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
