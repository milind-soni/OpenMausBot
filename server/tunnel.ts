// `openmausbot serve --tunnel`: every public request arrives over an IPC listener, so request-auth always demands a paired session.
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
import { ControlPlaneError, createControlPlaneClient } from "../electron/control-plane-client.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  stagedCloudflaredPath,
  type ManagedTunnelAccess,
  type ManagedTunnelState,
} from "../electron/managed-companion-tunnel.mjs";
import { createSecureCredentialState } from "../electron/secure-credential-state.mjs";
import { writeFileAtomic } from "./atomic.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TUNNEL_CREDENTIALS_FILE = "tunnel-account.json";
export const TUNNEL_RUNTIME_DIR = "tunnel-runtime";

export type { CompanionOriginEndpoint, ManagedTunnelAccess, ManagedTunnelState };

export interface TunnelCredentials {
  file: string;
  /** `unavailable`: the file exists but is unreadable, and nothing may be written over it. */
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

export function platformName(platform: NodeJS.Platform = process.platform): "darwin" | "windows" | "linux" {
  return platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
}

export interface TunnelAccount {
  service: CompanionAccountService;
  credentials: TunnelCredentials;
  controlPlane: string;
}

export interface TunnelRecovery {
  running(): RunningTunnel | null;
}

const STOPPED_TUNNEL: ManagedTunnelState = { status: "stopped", ready: false };

/** A server's operator owns its environment, so OMB_CONTROL_PLANE_URL is always honoured here (the desktop: dev builds only). */
export function createTunnelAccount(options: {
  dataDir: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  machineName?: string;
  recovery?: TunnelRecovery;
  log?: (line: string) => void;
  clock?: {
    setTimer: (callback: () => void, milliseconds: number) => unknown;
    clearTimer: (handle: unknown) => void;
    now: () => number;
  };
}): TunnelAccount {
  const env = options.env ?? process.env;
  const credentials = openTunnelCredentials(options.dataDir);
  const controlPlane = resolveCompanionControlPlaneURL({ isPackaged: true, environment: env });
  const client = controlPlane ? createControlPlaneClient({ baseURL: controlPlane, fetchImpl: options.fetchImpl }) : null;
  const recovery = options.recovery;
  const service = createCompanionAccountService({
    client,
    readCredentials: () => credentials.read(),
    updateCredentials: (derive, afterPersist) => credentials.update(derive, afterPersist),
    identity: { name: options.machineName ?? hostname(), platform: platformName(), appVersion: options.version },
    newClientInstanceId: () => randomUUID(),
    ...(options.log ? { log: options.log } : {}),
    ...(recovery
      ? {
          autoRecover: true,
          companionIsOn: () => recovery.running() !== null,
          managedConnectionState: () => recovery.running()?.state() ?? STOPPED_TUNNEL,
          activatePersistedEndpoint: async () => {
            const tunnel = recovery.running();
            const access = tunnelAccess(credentials.read());
            if (!tunnel || !access) return tunnel?.state() ?? STOPPED_TUNNEL;
            return tunnel.restart(access);
          },
          ...options.clock,
        }
      : {}),
  });
  return { service, credentials, controlPlane };
}

export const FLEET_CREDENTIAL_ENV = "OMB_INSTALLATION_CREDENTIAL";

/** A fleet container's installation credential comes from the environment; nothing is written to disk. */
export function fleetCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[FLEET_CREDENTIAL_ENV]?.trim();
  return value ? value : null;
}

export async function fleetAccess(options: { credential: string; version?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<ManagedTunnelAccess> {
  const env = options.env ?? process.env;
  const controlPlane = resolveCompanionControlPlaneURL({ isPackaged: true, environment: env });
  if (!controlPlane) throw new Error("OMB_CONTROL_PLANE_URL is set but is not an https address");
  const client = createControlPlaneClient({ baseURL: controlPlane, fetchImpl: options.fetchImpl });
  try {
    const { endpoint, connectorToken } = await client.ensureEndpoint(options.credential, { appVersion: options.version });
    return { endpoint: endpoint.url, token: connectorToken };
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 401) {
      throw new Error(`the installation credential in ${FLEET_CREDENTIAL_ENV} was rejected by ${controlPlane}; the fleet has to issue a new one`);
    }
    const reference = error instanceof ControlPlaneError && error.requestId ? ` (reference ${error.requestId})` : "";
    throw new Error(`could not get this machine's public address from ${controlPlane}: ${error instanceof Error ? error.message : String(error)}${reference}`);
  }
}

/** OMB_CLOUDFLARED_PATH, then the copy this command downloaded into the data
 * dir, then PATH. */
export function cloudflaredPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveCloudflaredBinary({ isPackaged: false, appPath: dataDir, environment: env });
}

export function prepareEntry(here = HERE): string {
  const bundled = join(here, "prepare-cloudflared.js");
  return existsSync(bundled) ? bundled : resolve(here, "..", "scripts", "prepare-cloudflared.mjs");
}

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
  const staged = stagedCloudflaredPath({ appPath: options.dataDir });
  const refreshStaged = !env.OMB_CLOUDFLARED_PATH?.trim() && found === staged;
  if (found && !refreshStaged) return found;
  options.log(
    refreshStaged
      ? `checking staged cloudflared (pinned version and digest) in ${options.dataDir}`
      : `downloading cloudflared once (pinned version and digest, about 40 MB) into ${options.dataDir}`,
  );
  await new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [prepareEntry(options.here), "--current", "--root", options.dataDir], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error) => fail(new Error(`could not prepare cloudflared: ${error.message}`)));
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`the cloudflared ${refreshStaged ? "refresh" : "download"} failed (exit ${code ?? "signal"})`))));
  });
  const prepared = refreshStaged ? (existsSync(staged) ? staged : null) : cloudflaredPath(options.dataDir, env);
  if (!prepared) throw new Error("cloudflared was prepared but is not where it should be; remove the data dir's dist-native folder and try again");
  return prepared;
}

export function createTunnelOrigin(): CompanionOriginEndpoint {
  return createCompanionOriginEndpoint({ processId: process.pid });
}

export function cleanupTunnelOrigin(origin: CompanionOriginEndpoint): void {
  cleanupCompanionOriginEndpoint(origin);
}

export interface RunningTunnel {
  address: string;
  state(): ManagedTunnelState;
  started: Promise<ManagedTunnelState>;
  restart(access: ManagedTunnelAccess): Promise<ManagedTunnelState>;
  stop(): Promise<void>;
}

/** The control plane points the tunnel at 127.0.0.1:8812 (OMB_TUNNEL_ORIGIN_PORT for tests); the gateway forwards to the IPC socket. */
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
    restart: (access) => tunnel.start({ endpoint: access.endpoint, token: access.token, originTarget: options.originTarget }),
    stop: async () => {
      await tunnel.stop();
    },
  };
}

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
