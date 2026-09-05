// Rung three of the hosting ladder: `openmausbot serve --tunnel` gives a
// server a public HTTPS address (https://c-<id>.openmausbot.com) with no
// domain, no proxy and no open port, through the same control plane and
// Cloudflare tunnel the desktop app already uses. Headless, so:
//
//   - the account and connector credentials live in a 0600 JSON file under
//     the data dir instead of the OS keychain (a server has none; a key kept
//     next to the ciphertext would be theatre), and its mode is re-tightened
//     on every open;
//   - cloudflared is fetched once into the data dir, by the same pinned
//     version + digest script the release build uses, when nothing usable is
//     on the machine;
//   - the tunnel's loopback gateway forwards to an IPC listener the harness
//     opens for it (OMB_TUNNEL_SOCKET), so to request-auth every public
//     request is "through a proxy" by construction and needs a paired
//     session — the loopback bind and its owner trust are untouched.
//
// Everything network- and process-shaped is the desktop's own code
// (electron/control-plane-client.mjs, companion-account-service.mjs,
// managed-companion-tunnel.mjs and the connector guardian): one
// implementation, so a fix lands in both.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_INSTALLATION_ID_FIELD,
  createCompanionAccountService,
  resolveCompanionControlPlaneURL,
  type CompanionAccountService,
  type CredentialDocument,
} from "../electron/companion-account-service.mjs";
import {
  cleanupCompanionOriginEndpoint,
  createCompanionOriginEndpoint,
  MANAGED_COMPANION_ORIGIN_PORT,
  type CompanionOriginEndpoint,
} from "../electron/companion-origin-gateway.mjs";
import { createControlPlaneClient } from "../electron/control-plane-client.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  type ManagedTunnelAccess,
  type ManagedTunnelState,
} from "../electron/managed-companion-tunnel.mjs";
import { createSecureCredentialState } from "../electron/secure-credential-state.mjs";
import { writeFileAtomic } from "./atomic.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TUNNEL_CREDENTIALS_FILE = "tunnel-account.json";
export const TUNNEL_RUNTIME_DIR = "tunnel-runtime";

export type { CompanionOriginEndpoint, ManagedTunnelAccess, ManagedTunnelState };

// ── credentials: a private file, and "unreadable" is not "empty" ─────────
export interface TunnelCredentials {
  file: string;
  /** `unavailable` = the file exists but could not be read: nothing may be
   * written over it, or a real account would be replaced by a fresh one. */
  status: "ok" | "empty" | "unavailable";
  read(): CredentialDocument;
  update(
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ): Promise<unknown>;
}

function plainDocument(value: unknown): CredentialDocument | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const document: CredentialDocument = {};
  for (const [key, entry] of Object.entries(value)) document[key] = entry;
  return document;
}

export function openTunnelCredentials(dataDir: string): TunnelCredentials {
  const file = join(dataDir, TUNNEL_CREDENTIALS_FILE);
  let initial: CredentialDocument = {};
  let status: TunnelCredentials["status"] = "empty";
  if (existsSync(file)) {
    try {
      // A file someone loosened (or an old umask) is tightened, not trusted as is.
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
      const parsed = plainDocument(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed) throw new Error("not a JSON object");
      initial = parsed;
      status = "ok";
    } catch {
      status = "unavailable";
    }
  }
  const persist = (next: CredentialDocument) => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  };
  const state = createSecureCredentialState(initial, persist, { writable: status !== "unavailable" });
  return {
    file,
    status,
    read: () => state.read(),
    update: (derive, afterPersist) => state.update(derive, afterPersist),
  };
}

// ── the account this machine is signed in to ──────────────────────────
export interface TunnelAccountSummary {
  email: string | null;
  address: string | null;
  installationId: string | null;
}

function stringField(document: CredentialDocument, field: string): string | null {
  const value = document[field];
  return typeof value === "string" && value ? value : null;
}

export function describeTunnelAccount(document: CredentialDocument): TunnelAccountSummary {
  return {
    email: stringField(document, COMPANION_ACCOUNT_EMAIL_FIELD),
    address: managedCompanionTunnelAccess(document)?.endpoint ?? null,
    installationId: stringField(document, COMPANION_INSTALLATION_ID_FIELD),
  };
}

export function tunnelAccess(document: CredentialDocument): ManagedTunnelAccess | null {
  return managedCompanionTunnelAccess(document);
}

/** The control plane's platform vocabulary. */
export function platformName(platform: NodeJS.Platform = process.platform): "darwin" | "windows" | "linux" {
  return platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
}

export interface TunnelAccount {
  service: CompanionAccountService;
  credentials: TunnelCredentials;
  /** "" when OMB_CONTROL_PLANE_URL is set to something unusable. */
  controlPlane: string;
}

/** The desktop honours OMB_CONTROL_PLANE_URL only in development builds; a
 * server's operator owns its environment, so it is honoured here always and
 * the caller says so in its output. */
export function createTunnelAccount(options: {
  dataDir: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  machineName?: string;
}): TunnelAccount {
  const env = options.env ?? process.env;
  const credentials = openTunnelCredentials(options.dataDir);
  const controlPlane = resolveCompanionControlPlaneURL({ isPackaged: true, environment: env });
  const client = controlPlane ? createControlPlaneClient({ baseURL: controlPlane, fetchImpl: options.fetchImpl }) : null;
  const service = createCompanionAccountService({
    client,
    readCredentials: () => credentials.read(),
    updateCredentials: (derive, afterPersist) => credentials.update(derive, afterPersist),
    identity: { name: options.machineName ?? hostname(), platform: platformName(), appVersion: options.version },
    newClientInstanceId: () => randomUUID(),
  });
  return { service, credentials, controlPlane };
}

// ── cloudflared and the guardian: where they are, or how to get them ──────
/** OMB_CLOUDFLARED_PATH, then the copy this command downloaded into the data
 * dir, then PATH. */
export function cloudflaredPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveCloudflaredBinary({ isPackaged: false, appPath: dataDir, environment: env });
}

/** The pinned-download script: bundled beside the server in a package or
 * image, the source in a checkout. */
export function prepareEntry(here = HERE): string {
  const bundled = join(here, "prepare-cloudflared.js");
  return existsSync(bundled) ? bundled : resolve(here, "..", "scripts", "prepare-cloudflared.mjs");
}

/** The connector guardian (the process that owns the gateway and cloudflared
 * and tears both down if this process dies), same rule. */
export function guardianEntry(here = HERE): string | null {
  const bundled = join(here, "tunnel-guardian.js");
  if (existsSync(bundled)) return bundled;
  const source = resolve(here, "..", "electron", "managed-companion-guardian-main.mjs");
  return existsSync(source) ? source : null;
}

export async function ensureCloudflared(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  here?: string;
}): Promise<string> {
  const env = options.env ?? process.env;
  const found = cloudflaredPath(options.dataDir, env);
  if (found) return found;
  options.log(`downloading cloudflared once (pinned version and digest, about 40 MB) into ${options.dataDir}`);
  await new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [prepareEntry(options.here), "--current", "--root", options.dataDir], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`the cloudflared download failed (exit ${code ?? "signal"})`))));
  });
  const staged = cloudflaredPath(options.dataDir, env);
  if (!staged) throw new Error("cloudflared was downloaded but is not where it should be; remove the data dir's dist-native folder and try again");
  return staged;
}

// ── the origin: an IPC path the harness listens on for the gateway ────────
export function createTunnelOrigin(): CompanionOriginEndpoint {
  return createCompanionOriginEndpoint({ processId: process.pid });
}

export function cleanupTunnelOrigin(origin: CompanionOriginEndpoint): void {
  cleanupCompanionOriginEndpoint(origin);
}

// ── the tunnel itself ────────────────────────────────────────────────────
export interface RunningTunnel {
  address: string;
  state(): ManagedTunnelState;
  /** Resolves with the first settled attempt: ready, or the reason it is retrying. */
  started: Promise<ManagedTunnelState>;
  stop(): Promise<void>;
}

/** The gateway listens on 127.0.0.1:<originPort> (the control plane points
 * the tunnel at 8812; OMB_TUNNEL_ORIGIN_PORT exists for tests) and forwards
 * to the harness's IPC socket. Verification polls the public address until
 * it answers as this app, then retries with backoff forever if it never does. */
export function startTunnel(options: {
  dataDir: string;
  access: ManagedTunnelAccess;
  originTarget: { pid: number; socketPath: string };
  binaryPath: string;
  guardian: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  onState?: (state: ManagedTunnelState) => void;
}): RunningTunnel {
  const env = options.env ?? process.env;
  const originPort = Number(env.OMB_TUNNEL_ORIGIN_PORT || MANAGED_COMPANION_ORIGIN_PORT);
  let current: ManagedTunnelState = { status: "stopped", ready: false };
  const tunnel = createManagedCompanionTunnel({
    binaryPath: options.binaryPath,
    guardianEntry: options.guardian,
    runtimeRoot: join(options.dataDir, TUNNEL_RUNTIME_DIR),
    originPort,
    environment: env,
    fetchImpl: options.fetchImpl,
    onChange: (state) => {
      current = state;
      options.onState?.(state);
    },
  });
  const started = tunnel.start({ endpoint: options.access.endpoint, token: options.access.token, originTarget: options.originTarget });
  return {
    address: options.access.endpoint,
    state: () => current,
    started,
    stop: async () => {
      await tunnel.stop();
    },
  };
}

/** One line per state change, for a terminal or a journal. */
export function describeTunnelState(state: ManagedTunnelState, address: string): string {
  switch (state.status) {
    case "starting":
      return "tunnel: connecting…";
    case "ready":
      return `tunnel: live at ${address}`;
    case "retrying":
      return `tunnel: ${state.error ?? "not verified yet"} retrying in ${Math.max(1, Math.round((state.retryInMs ?? 0) / 1000))}s`;
    case "stopped":
      return "tunnel: stopped";
    default:
      return `tunnel: ${state.error ?? state.status}`;
  }
}
