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
import { createE2EOrigin, e2eContextOf } from "../companion/src/e2e/origin.ts";
import { E2ERegistry, type E2EContext, type E2EDevices } from "../companion/src/e2e/registry.ts";
import { RelayClient, type RelayStatus } from "../companion/src/e2e/relay-client.ts";
import { COMPANION_INSTALLATION_CREDENTIAL_FIELD, resolveCompanionControlPlaneURL } from "../electron/companion-account-service.mjs";
import { createControlPlaneClient } from "../electron/control-plane-client.mjs";
import { createRelayTokenService, type RelayGrant } from "../electron/relay-token.mjs";
import { isLoopbackHost } from "../electron/server-address.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { bearerToken, PROXY_HEADERS } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";
import { fleetCredential, openTunnelCredentials } from "./tunnel.ts";

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
/** The rate-limit source of a pairing over the relay: the source address of every relayed request is the relay. */
const RELAY_SOURCE = "phone-relay";
const PAIRING_SESSION_ROUTES = new Set(["POST /api/pair", "GET /api/health"]);

export type PhoneRelayGrantState = "waiting" | "ok" | "signed-out" | "unavailable" | "failed";

export interface PhoneRelayStatus {
  relay: RelayStatus;
  node: string | null;
  grant: PhoneRelayGrantState;
  phones: number;
  maxPhones: number;
}

export interface PhoneRelay {
  status(): PhoneRelayStatus;
  /** The phone-app link for one pairing credential, or null until the relay identity is known. */
  invite(credential: string, name: string | undefined, publicOrigin: string | null): string | null;
  /** What `POST /api/pair` adds for a phone that paired through the relay. */
  pairedOver(req: IncomingMessage): { e2e?: E2EDescriptor };
  stop(): void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

export interface PhoneRelayOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  sessions: Pick<SessionRegistry, "bearerDigests" | "pairingDigests" | "onSessionIssued" | "onSessionRevoked" | "list">;
  handle: Handler;
  serverName(): string;
  publicOrigin(): string | null;
  version: string;
  /** Why this server never runs the relay (a Cloud home, a hosted workspace, the desktop app), or null. */
  refusal: string | null;
  /** Tests: the control plane's relay-token answer. */
  fetchGrant?: (devices: { e2e: number; legacy: number }) => Promise<unknown>;
  log?: (line: string) => void;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && left.length === right.length && timingSafeEqual(left, right);
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

/** Null unless OMB_PHONE_RELAY=1, and when it cannot run here: the server works on without it either way. */
export function startPhoneRelay(options: PhoneRelayOptions): PhoneRelay | null {
  if (options.env[PHONE_RELAY_ENV] !== "1") return null;
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.refusal) {
    log(`phone relay: off on ${options.refusal}`);
    return null;
  }
  const { sessions, dataDir } = options;
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
  const baseUrl = relayBaseUrlOverride(options.env.OMB_PHONE_RELAY_URL);
  const descriptor = () => e2e.descriptor(null);

  const counts = () => {
    const e2eCount = devices.records().length;
    // Every other device of a server reaches it some other way, so the control plane never takes that way back.
    return { e2e: Math.min(e2eCount, 100), legacy: Math.min(Math.max(sessions.list().length - e2eCount, 0), 100) };
  };
  const controlPlane = resolveCompanionControlPlaneURL({ isPackaged: true, environment: options.env });
  const client = controlPlane ? createControlPlaneClient({ baseURL: controlPlane }) : null;
  const fetchGrant = options.fetchGrant ?? (async (devicesNow: { e2e: number; legacy: number }) => {
    const document = openTunnelCredentials(dataDir).read();
    const stored = document[COMPANION_INSTALLATION_CREDENTIAL_FIELD];
    const credential = fleetCredential(options.env) ?? (typeof stored === "string" ? stored : null);
    if (!client || !credential) throw Object.assign(new Error("signed out"), { code: "signed_out" });
    return client.relayToken(credential, { appVersion: options.version, devices: devicesNow });
  });

  const tokens = createRelayTokenService({
    fetchGrant: async () => {
      try {
        const grant = await fetchGrant(counts());
        grantState = "ok";
        return grant;
      } catch (error) {
        const failure = error as { code?: unknown; status?: unknown };
        grantState = failure.code === "relay_unavailable" ? "unavailable" : failure.code === "signed_out" || failure.status === 401 ? "signed-out" : "failed";
        throw error;
      }
    },
    onGrant: (grant) => applyGrant(grant),
    log: (line) => log(`phone relay: ${line}`),
  });

  const origin = createE2EOrigin((req, res) => relayed(req, res), (_req, socket) => refuseUpgrade(socket));

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
  function scrub(req: IncomingMessage): void {
    for (const name of Object.keys(req.headers)) {
      if (name === "cookie" || name.startsWith("x-openmausbot-") || (PROXY_HEADERS as readonly string[]).includes(name)) delete req.headers[name];
    }
    req.headers.host = "phone-relay.invalid";
    req.headers["x-forwarded-for"] = RELAY_SOURCE;
  }

  function relayed(req: IncomingMessage, res: ServerResponse): void {
    const context = e2eContextOf(req.socket);
    if (!context) return reply(res, 500, { error: "not a relayed request" });
    scrub(req);
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";
    const peer = context.peer;
    if (peer.kind === "pairing") {
      if (!PAIRING_SESSION_ROUTES.has(`${method} ${path}`)) return reply(res, 401, { error: "pair this phone first" });
      if (method === "POST" && devices.records().length >= MAX_RELAY_PHONES) {
        return reply(res, 409, { error: `This server has ${MAX_RELAY_PHONES} phones on MausBot Relay. Remove one (openmausbot devices revoke ID), then pair again.` });
      }
    } else {
      const bearer = bearerToken(req.headers.authorization);
      const own = devices.records().find((record) => record.id === peer.id);
      if (bearer && (!own || !sameDigest(own.tokenHash, sha256Hex(bearer)))) return reply(res, 401, { error: "this connection belongs to another device" });
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
    status: () => ({ relay: relay?.status ?? "off", node: relay?.node ?? null, grant: grantState, phones: devices.records().length, maxPhones: MAX_RELAY_PHONES }),
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
    stop() {
      stopIssued();
      stopRevoked();
      tokens.stop();
      e2e.closeAll();
      origin.close();
    },
  };
}
