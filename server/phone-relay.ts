// `serve --relay`: phones reach this server through MausBot Relay, end-to-end encrypted as they reach the desktop app.
// The server dials out to the relay, the phone dials the relay, and the relay splices sealed bytes it cannot open. Every
// encrypted stream lands in the server's own request handler as a remote request, so a phone signs in with its own session.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { phonePairingLink, type CompanionEndpoint } from "../shared/pairing-link.ts";
import { relayBaseUrlOverride } from "../companion/src/e2e/config.ts";
import { b64u, fromB64u } from "../companion/src/e2e/credentials.ts";
import type { E2EDescriptor } from "../companion/src/e2e/descriptor.ts";
import { generateKeyPair, keyPairFromPrivate, TRANSPORT_RELAY, type KeyPair } from "../companion/src/e2e/noise.ts";
import { createE2EOrigin, e2eContextOf, type E2EOriginDeadlines } from "../companion/src/e2e/origin.ts";
import { E2ERegistry, type E2EContext, type E2EDevices, type Peer } from "../companion/src/e2e/registry.ts";
import { RelayClient, type RelayStatus } from "../companion/src/e2e/relay-client.ts";
import { COMPANION_INSTALLATION_CREDENTIAL_FIELD, resolveCompanionControlPlaneURL } from "../electron/companion-account-service.mjs";
import { createControlPlaneClient } from "../electron/control-plane-client.mjs";
import { MANAGED_COMPANION_ENDPOINT_FIELD } from "../electron/managed-companion-tunnel.mjs";
import { createRelayTokenService, validRelayGrant, type RelayGrant } from "../electron/relay-token.mjs";
import { isLoopbackHost } from "../electron/server-address.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { bearerToken, PROXY_HEADERS } from "./request-auth.ts";
import { isPairingCredential, type SessionRegistry } from "./sessions.ts";
import { describeTunnelAccount, FLEET_CREDENTIAL_ENV, fleetCredential, openTunnelCredentials } from "./tunnel.ts";
import type { E2ESession } from "../companion/src/e2e/session.ts";

export const PHONE_RELAY_ENV = "OMB_PHONE_RELAY";
export const PHONE_RELAY_KEY_FILE = "phone-relay-key.json";
export const PHONE_RELAY_PHONES_FILE = "phone-relay-phones.json";
/** The relay admits 32 per host; 20 phones, 2 pairing windows and the live pairing sessions stay under it. */
export const MAX_RELAY_PHONES = 20;
const MAX_PAIRING_WINDOWS = 2;
/** A removed phone hears GoAway(3) inside its session before the relay drops it from the admission set. */
const ADMISSION_SETTLE_MS = 300;
/** RFC 6761 reserves `.invalid`: a QR with no public address names a host that never resolves, so only the relay works. */
const RELAY_ONLY_ADDRESS = "relay-only.invalid";
/** Live sessions one phone may hold, and sessions on one pairing window: the relay carries 16 per server. */
export const MAX_SESSIONS_PER_PHONE = 4;
const MAX_SESSIONS_PER_WINDOW = 2;
const STREAM_DEADLINES: E2EOriginDeadlines = { headersMs: 30_000, requestMs: 300_000 };
const PAIRING_SESSION_ROUTES = new Set(["POST /api/pair", "GET /api/health"]);

/** `tunnel`: this machine holds or needs a tunnel address, so it never asks for a relay token (`reason` says why). */
export type PhoneRelayGrantState = "waiting" | "ok" | "signed-out" | "unavailable" | "failed" | "tunnel";

export interface PhoneRelayStatus {
  relay: RelayStatus;
  node: string | null;
  grant: PhoneRelayGrantState;
  reason?: string;
  phones: number;
  maxPhones: number;
}

export interface PhoneRelay {
  status(): PhoneRelayStatus;
  /** The phone-app link for one pairing credential, or null until the relay identity is known. */
  invite(credential: string, name: string | undefined, publicOrigin: string | null): string | null;
  /** What `POST /api/pair` adds for a phone that paired through the relay. */
  pairedOver(req: IncomingMessage): { e2e?: E2EDescriptor };
  /** Why `POST /api/pair` refuses this input, or null: through the relay only the QR's credential pairs, never a code. */
  pairingRefusal(req: IncomingMessage, input: string): string | null;
  stop(): void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

export interface PhoneRelayOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  sessions: Pick<SessionRegistry, "bearerDigests" | "pairingDigests" | "onSessionIssued" | "onSessionRevoked" | "list" | "ticketOwner">;
  handle: Handler;
  serverName(): string;
  publicOrigin(): string | null;
  version: string;
  /** Why this server never runs the relay (a Cloud home, a hosted workspace, the desktop app), or null. */
  refusal: string | null;
  /** Tests: the control plane's relay-token answer, and shorter stream deadlines. */
  fetchGrant?: (devices: { e2e: number; legacy: number }) => Promise<unknown>;
  streamDeadlines?: E2EOriginDeadlines;
  log?: (line: string) => void;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && left.length === right.length && timingSafeEqual(left, right);
}

/** The pairing lockout's source for a relayed request: the device, or the pairing window the session holds. Every relayed
 * request comes from the relay's address, and one phone must not lock pairing for every other. */
function sourceOf(peer: Peer): string {
  return peer.kind === "device" ? `relay-${peer.id.slice(0, 48)}` : `relay-window-${(peer.admHash ?? "none").slice(0, 22)}`;
}

/** Created once with mode 0600 and never replaced: every paired phone pinned its public half from the QR. */
export function phoneRelayKey(dataDir: string): KeyPair {
  const file = join(dataDir, PHONE_RELAY_KEY_FILE);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; privateKey?: unknown };
    const raw = parsed.v === 1 && typeof parsed.privateKey === "string" ? fromB64u(parsed.privateKey) : null;
    if (!raw || raw.length !== 32) throw new Error(`${file} is not a connection key; phones paired through the relay need it, so it was left as it is`);
    return keyPairFromPrivate(raw);
  }
  const key = generateKeyPair();
  writeFileAtomic(file, `${JSON.stringify({ v: 1, privateKey: b64u(key.privateKey) })}\n`, { mode: 0o600 });
  return key;
}

function readPhones(dataDir: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, PHONE_RELAY_PHONES_FILE), "utf8")) as { v?: unknown; phones?: unknown };
    return new Set(parsed.v === 1 && Array.isArray(parsed.phones) ? parsed.phones.filter((id): id is string => typeof id === "string" && id.length <= 128) : []);
  } catch {
    return new Set();
  }
}

/** The way in a QR names besides the relay: this server's public HTTPS address, which a phone without the encrypted
 * connection uses and one with it never does, or a name that never resolves. */
function qrRoute(publicOrigin: string | null): { address: string; port: number; hosts?: string[]; endpoints?: CompanionEndpoint[] } {
  try {
    const url = publicOrigin ? new URL(publicOrigin) : null;
    if (url?.protocol === "https:" && !isLoopbackHost(url.host)) {
      return { address: url.hostname, port: url.port ? Number(url.port) : 443, hosts: [url.hostname], endpoints: [{ url: url.origin, kind: "hosted", priority: 0 }] };
    }
  } catch {
    // A malformed address is no way in.
  }
  return { address: RELAY_ONLY_ADDRESS, port: 443 };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

/** Why this machine must not take a relay token, or null. Security: the control plane does not yet tell a server from a
 * desktop, and gives back the tunnel of any installation that recently took a relay token, then refuses it another. So
 * a machine that serves a tunnel, runs on a fleet credential, or holds a tunnel address from `login` never asks. */
export function tunnelHolder(env: NodeJS.ProcessEnv, dataDir: string): string | null {
  if (env.OMB_TUNNEL_SOCKET?.trim()) return "this server runs with --tunnel";
  if (fleetCredential(env)) return `${FLEET_CREDENTIAL_ENV} is set, and a fleet installation keeps its tunnel`;
  const account = openTunnelCredentials(dataDir);
  if (account.status === "unavailable") return `${account.file} could not be read, so this machine may hold a tunnel address`;
  const document = account.read();
  if (describeTunnelAccount(document).address || document[MANAGED_COMPANION_ENDPOINT_FIELD]) return "this machine holds a tunnel address from `openmausbot login`";
  return null;
}

function offForTunnel(reason: string): PhoneRelay {
  return {
    status: () => ({ relay: "off", node: null, grant: "tunnel", reason, phones: 0, maxPhones: MAX_RELAY_PHONES }),
    invite: () => null,
    pairedOver: () => ({}),
    pairingRefusal: () => null,
    stop: () => {},
  };
}

const TUNNEL_HELD = "tunnel_held";

/** Null unless OMB_PHONE_RELAY=1, and when it cannot run here: the server works on without it either way. */
export function startPhoneRelay(options: PhoneRelayOptions): PhoneRelay | null {
  if (options.env[PHONE_RELAY_ENV] !== "1") return null;
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.refusal) {
    log(`phone relay: off on ${options.refusal}`);
    return null;
  }
  const { sessions, dataDir } = options;
  const holder = tunnelHolder(options.env, dataDir);
  if (holder) {
    log(`phone relay: off: ${holder}. Use the relay on a machine signed in with \`openmausbot login --relay\`, which holds no tunnel address.`);
    return offForTunnel(holder);
  }
  let key: KeyPair;
  try {
    key = phoneRelayKey(dataDir);
  } catch (error) {
    log(`phone relay: off: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const phones = readPhones(dataDir);
  const savePhones = () => writeFileAtomic(join(dataDir, PHONE_RELAY_PHONES_FILE), `${JSON.stringify({ v: 1, phones: [...phones] })}\n`, { mode: 0o600 });
  const devices: E2EDevices = {
    records: () => sessions.bearerDigests(phones),
    pairingWindows: () => sessions.pairingDigests(MAX_PAIRING_WINDOWS).map((tokenHash) => ({ tokenHash })),
    confirm: () => {},
    markE2E: () => {},
  };
  const live = new Set(devices.records().map((record) => record.id));
  if (live.size !== phones.size) {
    for (const id of phones) if (!live.has(id)) phones.delete(id);
    savePhones();
  }
  const e2e = new E2ERegistry(devices);
  e2e.setKey(key);
  log(`phone relay: on, connection key ${b64u(key.publicKey).slice(0, 8)}…`);

  const pairing = new AsyncLocalStorage<E2EContext>();
  let relay: RelayClient | null = null;
  let grantState: PhoneRelayGrantState = "waiting";
  let tunnelReason: string | null = null;
  const baseUrl = relayBaseUrlOverride(options.env.OMB_PHONE_RELAY_URL);
  const descriptor = () => e2e.descriptor(null);

  const counts = () => {
    const e2eCount = devices.records().length;
    // A server's other devices reach it some other way: they are the devices the relay does not carry.
    return { e2e: Math.min(e2eCount, 100), legacy: Math.min(Math.max(sessions.list().length - e2eCount, 0), 100) };
  };
  const controlPlane = resolveCompanionControlPlaneURL({ isPackaged: true, environment: options.env });
  const client = controlPlane ? createControlPlaneClient({ baseURL: controlPlane }) : null;
  const fetchGrant = options.fetchGrant ?? (async (devicesNow: { e2e: number; legacy: number }) => {
    const document = openTunnelCredentials(dataDir).read();
    const stored = document[COMPANION_INSTALLATION_CREDENTIAL_FIELD];
    tunnelReason = tunnelHolder(options.env, dataDir);
    if (tunnelReason) throw Object.assign(new Error(tunnelReason), { code: TUNNEL_HELD });
    const credential = typeof stored === "string" ? stored : null;
    if (!client || !credential) throw Object.assign(new Error("signed out"), { code: "signed_out" });
    return client.relayToken(credential, { appVersion: options.version, devices: devicesNow });
  });

  const tokens = createRelayTokenService({
    fetchGrant: async () => {
      try {
        const grant = await fetchGrant(counts());
        if (!validRelayGrant(grant)) throw Object.assign(new Error("invalid relay grant"), { code: "invalid_response" });
        grantState = "ok";
        return grant;
      } catch (error) {
        const failure = error as { code?: unknown; status?: unknown };
        if (failure.code === TUNNEL_HELD) applyGrant(null);
        const current = tokens.grant;
        grantState = failure.code === TUNNEL_HELD ? "tunnel"
          : failure.code === "relay_unavailable" ? "unavailable"
          : failure.code === "signed_out" || failure.status === 401 ? "signed-out"
          : current && current.expiresAt > Date.now() && relay ? "ok" : "failed";
        throw error;
      }
    },
    onGrant: (grant) => applyGrant(grant),
    log: (line) => log(`phone relay: ${line}`),
  });

  const origin = createE2EOrigin((req, res) => relayed(req, res), (_req, socket) => refuseUpgrade(socket), options.streamDeadlines ?? STREAM_DEADLINES);

  /** One phone (or one pairing window) holds a few live sessions; a new one closes its oldest, so a phone that lost its
   * sessions without the relay noticing can still come back. */
  const held = new Map<string, E2ESession<Peer>[]>();
  const holdSession = (session: E2ESession<Peer>) => {
    const peer = session.peer;
    if (!peer) return;
    const key = peer.kind === "device" ? `device ${peer.id}` : `window ${peer.admHash}`;
    const list = held.get(key) ?? [];
    list.push(session);
    held.set(key, list);
    const limit = peer.kind === "device" ? MAX_SESSIONS_PER_PHONE : MAX_SESSIONS_PER_WINDOW;
    while (list.length > limit) list.shift()!.shutdown();
    void session.closed.then(() => {
      const index = list.indexOf(session);
      if (index >= 0) list.splice(index, 1);
      if (!list.length && held.get(key) === list) held.delete(key);
    });
  };

  function applyGrant(grant: RelayGrant | null): void {
    const hostId = grant ? fromB64u(grant.hostId) : null;
    if (!grant || !hostId || !relay || !e2e.relay?.hostId.equals(hostId)) {
      relay?.stop();
      relay = null;
    }
    e2e.setRelay(grant && hostId ? { hostId, nodes: grant.nodes } : null);
    if (!grant || !hostId) return;
    if (relay) return relay.setToken(grant.token, grant.nodes);
    relay = new RelayClient({
      nodes: grant.nodes,
      token: grant.token,
      admissionSet: () => e2e.admissionSet(),
      accept: (transport) => {
        const session = e2e.accept(transport, TRANSPORT_RELAY, "relay", (context) => origin.connect(context));
        void session?.ready.then(() => holdSession(session), () => {});
        return session && { receive: (data, binary) => session.receive(data, binary), transportClosed: (code) => session.transportClosed(code) };
      },
      tokenRejected: () => void tokens.refreshNow(),
      statusChanged: (status, node) => log(`phone relay: ${status}${node ? ` via ${node}` : ""}`),
      baseUrl,
    });
    relay.start();
  }

  function refuseUpgrade(socket: Duplex): void {
    socket.end("HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  }

  /** Security: a relayed request is never this machine's. It has no peer address, which the request gate always treats as
   * remote, and whatever Host, proxy, cookie or owner headers the phone wrote are replaced: it needs a session of its own. */
  function scrub(req: IncomingMessage, peer: Peer): void {
    for (const name of Object.keys(req.headers)) {
      if (name === "cookie" || name.startsWith("x-openmausbot-") || (PROXY_HEADERS as readonly string[]).includes(name)) delete req.headers[name];
    }
    req.headers.host = "phone-relay.invalid";
    req.headers["x-forwarded-for"] = sourceOf(peer);
  }

  function relayed(req: IncomingMessage, res: ServerResponse): void {
    const context = e2eContextOf(req.socket);
    if (!context) return reply(res, 500, { error: "not a relayed request" });
    const peer = context.peer;
    scrub(req, peer);
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";
    if (method === "POST" && path === "/api/auth/pair") return reply(res, 404, { error: "pair a phone with its QR code" });
    if (peer.kind === "pairing") {
      if (!PAIRING_SESSION_ROUTES.has(`${method} ${path}`)) return reply(res, 401, { error: "pair this phone first" });
      if (method === "POST" && devices.records().length >= MAX_RELAY_PHONES) {
        return reply(res, 409, { error: `This server has ${MAX_RELAY_PHONES} phones on MausBot Relay. Remove one (openmausbot devices revoke ID), then pair again.` });
      }
    } else {
      const bearer = bearerToken(req.headers.authorization);
      const own = devices.records().find((record) => record.id === peer.id);
      if (bearer && (!own || !sameDigest(own.tokenHash, sha256Hex(bearer)))) return reply(res, 401, { error: "this connection belongs to another device" });
      const ticket = new URL(req.url ?? "/", "http://phone-relay.invalid").searchParams.get("ticket");
      if (ticket && sessions.ticketOwner(ticket) !== peer.id) return reply(res, 401, { error: "this connection belongs to another device" });
      if (method === "GET" && path === "/api/companion/endpoints") {
        if (!bearer) return reply(res, 401, { error: "pair this device first" });
        const route = qrRoute(options.publicOrigin());
        return reply(res, 200, { serverName: options.serverName(), endpoints: route.endpoints ?? [], ...(descriptor() ? { e2e: descriptor() } : {}) });
      }
    }
    void pairing.run(context, () => Promise.resolve(options.handle(req, res))).catch(() => {
      if (!res.headersSent) reply(res, 500, { error: "request failed" });
      else res.destroy();
    });
  }

  const stopIssued = sessions.onSessionIssued((session) => {
    const context = pairing.getStore();
    if (context?.peer.kind !== "pairing") return;
    phones.add(session.id);
    savePhones();
    e2e.paired(context, session.id);
    relay?.refreshAdmission();
  });
  const stopRevoked = sessions.onSessionRevoked((sessionId) => {
    if (!phones.delete(sessionId)) return;
    savePhones();
    e2e.closeDevice(sessionId);
    setTimeout(() => relay?.refreshAdmission(), ADMISSION_SETTLE_MS).unref();
  });
  e2e.onAdmissionChange(() => relay?.refreshAdmission());
  tokens.start();

  return {
    status: () => ({ relay: relay?.status ?? "off", node: relay?.node ?? null, grant: grantState, ...(grantState === "tunnel" && tunnelReason ? { reason: tunnelReason } : {}), phones: devices.records().length, maxPhones: MAX_RELAY_PHONES }),
    invite(credential, name, publicOrigin) {
      const current = descriptor();
      if (!current?.h || !current.r) return null;
      relay?.refreshAdmission();
      return phonePairingLink({ ...qrRoute(publicOrigin), token: credential, name, e2e: current });
    },
    pairedOver: (req) => {
      const current = e2eContextOf(req.socket) ? descriptor() : null;
      return current ? { e2e: current } : {};
    },
    pairingRefusal: (req, input) => (e2eContextOf(req.socket) && !isPairingCredential(input) ? "pair a phone with its QR code" : null),
    stop() {
      stopIssued();
      stopRevoked();
      tokens.stop();
      e2e.closeAll();
      origin.close();
    },
  };
}
