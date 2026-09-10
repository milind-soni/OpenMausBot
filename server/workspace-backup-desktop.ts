import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_CREDENTIAL_FIELDS,
  BACKUP_CREDENTIAL_NAMES,
  DESKTOP_BACKUP_CREDENTIAL_NAMES,
  WORKSPACE_BACKUP_REQUEST,
  WORKSPACE_BACKUP_RESULT,
  workspaceBackupCredentials,
  workspaceBackupEnvironment,
} from "../electron/workspace-backup-credentials.mjs";
import { writeFileAtomic } from "./atomic.ts";

type ParentPort = {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  removeListener(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: object): void;
};
const parentPort = () => (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const failure = () => new Error("The desktop credential store did not complete the backup operation. Quit and reopen the app, then try again.");
let pending = 0;
const currentDataDir = () => process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const portableFile = (dataDir: string) => join(dataDir, "workspace-credentials.json");

function readDocument(file: string, maxBytes = 2_097_152): Record<string, unknown> {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) throw failure();
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw failure();
  }
}

function configCredentials(config: Record<string, unknown>): Record<string, string> {
  const credentials: Record<string, unknown> = {};
  for (const { section, field, name } of BACKUP_CREDENTIAL_FIELDS) {
    const home = config[section];
    if (home && typeof home === "object" && Object.hasOwn(home, field)) credentials[name] = (home as Record<string, unknown>)[field];
  }
  return workspaceBackupCredentials(credentials, true);
}

function environmentCredentials(): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const { name, env } of BACKUP_CREDENTIAL_FIELDS) if (process.env[env] !== undefined) credentials[name] = process.env[env]!;
  if (process.env.OMB_COMPOSIO_BROKER_TOKEN !== undefined) credentials.composioBrokerToken = process.env.OMB_COMPOSIO_BROKER_TOKEN;
  if (process.env.OMB_COMPOSIO_BROKER_URL !== undefined) credentials.composioBrokerUrl = process.env.OMB_COMPOSIO_BROKER_URL;
  return workspaceBackupCredentials(credentials, true);
}

function request(operation: "read" | "restore", credentials?: Record<string, string>): Promise<Record<string, unknown>> {
  const port = parentPort();
  if (!port || pending >= 4) return Promise.reject(failure());
  pending += 1;
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.removeListener("message", receive);
      pending -= 1;
      if (error) reject(error);
      else resolve(result!);
    };
    const receive = ({ data }: { data?: unknown }) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const result = data as Record<string, unknown>;
      if (result.type !== WORKSPACE_BACKUP_RESULT || result.requestId !== requestId) return;
      finish(result.ok === true ? undefined : failure(), result);
    };
    // Parent mutations expire sooner, leaving time for its rollback and reply.
    const timer = setTimeout(() => finish(failure()), 20_000);
    timer.unref?.();
    port.on("message", receive);
    try { port.postMessage({ type: WORKSPACE_BACKUP_REQUEST, requestId, operation, ...(credentials ? { credentials } : {}) }); }
    catch { finish(failure()); }
  });
}

export async function readDesktopBackupCredentials(): Promise<Record<string, unknown> | null> {
  const dataDir = currentDataDir();
  const saved = workspaceBackupCredentials(readDocument(portableFile(dataDir), 131_072), true);
  const credentials = { ...Object.fromEntries(BACKUP_CREDENTIAL_NAMES.map((name) => [name, ""])), ...saved, ...configCredentials(readDocument(join(dataDir, "config.json"))), ...environmentCredentials() };
  if (!parentPort()) {
    if (process.env.OMB_DESKTOP_PARENT === "1") throw failure();
  } else {
    // Managed Composio can refresh privately after spawn without changing
    // the child's inherited env. The parent's committed state wins for its
    // own keys; config-backed providers keep loadConfig's normal env rule.
    const current = workspaceBackupCredentials((await request("read")).credentials, true);
    for (const name of DESKTOP_BACKUP_CREDENTIAL_NAMES) credentials[name] = current[name] ?? "";
  }
  return credentials;
}

export async function restoreDesktopBackupCredentials(credentials: Record<string, unknown>): Promise<void> {
  const restored = workspaceBackupCredentials(credentials, true);
  if (!parentPort()) {
    if (process.env.OMB_DESKTOP_PARENT === "1") throw failure();
    Object.assign(process.env, workspaceBackupEnvironment(restored, process.env.OMB_COMPOSIO_BROKER_URL ?? ""));
    return;
  }
  const result = await request("restore", restored);
  if (!result.environment || typeof result.environment !== "object" || Array.isArray(result.environment)) throw failure();
  const environment = result.environment as Record<string, unknown>;
  if (Object.hasOwn(restored, "composioBrokerToken") && typeof environment.OMB_COMPOSIO_BROKER_URL !== "string") throw failure();
  Object.assign(process.env, workspaceBackupEnvironment(restored, String(environment.OMB_COMPOSIO_BROKER_URL ?? "")));
}

/** Called after the restored data swap, before loadConfig. Headless secrets
 * stay in a private file/config; desktop removes plaintext only after the
 * private parent has durably accepted the same credentials. */
export function persistWorkspaceBackupCredentials(dataDir: string, incoming: Record<string, unknown>): void {
  const configPath = join(dataDir, "config.json");
  const config = readDocument(configPath);
  const credentials = workspaceBackupCredentials(incoming, true);
  const desktop = Boolean(parentPort());
  if (!desktop && process.env.OMB_DESKTOP_PARENT === "1") throw failure();
  const portable = workspaceBackupCredentials(readDocument(portableFile(dataDir), 131_072), true);
  // The caller already committed these keys privately. Never delete an
  // uncaptured portable credential that has not been accepted by the store.
  if (desktop && Object.keys(portable).some((name) => !Object.hasOwn(credentials, name))) throw failure();
  for (const { section, field, name } of BACKUP_CREDENTIAL_FIELDS) {
    if (!Object.hasOwn(credentials, name)) continue;
    const home = config[section];
    if (home !== undefined && (!home || typeof home !== "object" || Array.isArray(home))) throw failure();
    const next = { ...(home as Record<string, unknown> | undefined) };
    if (desktop && DESKTOP_BACKUP_CREDENTIAL_NAMES.includes(name)) delete next[field];
    else next[field] = credentials[name];
    config[section] = next;
  }
  if (!desktop) writeFileAtomic(portableFile(dataDir), JSON.stringify({ ...portable, ...credentials }), { mode: 0o600 });
  writeFileAtomic(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (desktop) {
    try { unlinkSync(portableFile(dataDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); }
  }
}

export async function prepareWorkspaceBackupCredentials(dataDir: string, incoming: Record<string, unknown>): Promise<void> {
  const credentials = {
    ...workspaceBackupCredentials(readDocument(portableFile(dataDir), 131_072), true),
    ...configCredentials(readDocument(join(dataDir, "config.json"))),
    ...workspaceBackupCredentials(incoming, true),
  };
  await restoreDesktopBackupCredentials(credentials);
  persistWorkspaceBackupCredentials(dataDir, credentials);
}

/** Boot hook: reload portable headless identity on subsequent launches, or
 * migrate it into the OS store when moving that workspace to the desktop. */
export async function loadWorkspaceBackupCredentials(dataDir: string): Promise<void> {
  const credentials = workspaceBackupCredentials(readDocument(portableFile(dataDir), 131_072), true);
  if (!Object.keys(credentials).length) return;
  if (parentPort()) await prepareWorkspaceBackupCredentials(dataDir, { ...credentials, ...configCredentials(readDocument(join(dataDir, "config.json"))) });
  else {
    if (process.env.OMB_DESKTOP_PARENT === "1") throw failure();
    // Later explicit config edits beat an old portable key; launch env wins.
    Object.assign(process.env, workspaceBackupEnvironment({ ...credentials, ...configCredentials(readDocument(join(dataDir, "config.json"))), ...environmentCredentials() }, process.env.OMB_COMPOSIO_BROKER_URL ?? ""));
  }
}
