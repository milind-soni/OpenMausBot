// What OpenMausBot keeps for an OpenConnector installation: connection aliases and labels that map
// to runtime connections, per-app OAuth client records whose secrets are sealed, and nothing else —
// credentials themselves live on the OpenConnector runtime. Sealing mirrors server/webhooks.ts: a
// random AES-256-GCM key in a 0600 file no backup carries (workspace-backup-policy excludes it).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import { parseJson } from "../../schema.ts";

export const OPENCONNECTOR_STATE_FILE = "openconnector-state.json";
export const CONNECTOR_KEY_FILE = "connector-key";

/** "oc:<service>:<alias>" — the only account id shape this provider issues
 * The alias is percent-encoded so a printable alias can never collide with the separator. */
export function accountIdForConnection(service: string, alias?: string): string {
  return `oc:${service}:${encodeURIComponent(alias?.trim() || "default")}`;
}

export function parseConnectionAccountId(accountId: string): { service: string; alias: string } | null {
  const parts = accountId.split(":");
  if (parts.length !== 3 || parts[0] !== "oc" || !parts[1]) return null;
  try {
    return { service: parts[1], alias: decodeURIComponent(parts[2]) || "default" };
  } catch {
    return null;
  }
}

const connectionRecordSchema = z.object({
  accountId: z.string(),
  service: z.string(),
  alias: z.string().optional(),
  label: z.string().optional(),
  connectionRequestId: z.string().optional(),
  status: z.string(),
  lastError: z.string().max(400).optional(),
  updatedAt: z.string(),
});

export type OpenConnectorConnectionRecord = z.infer<typeof connectionRecordSchema>;

/** "ACTIVE" is the public inventory spelling; the runtime and older local records use "connected". */
export const isConnectedConnectionRecord = (record: OpenConnectorConnectionRecord): boolean =>
  record.status === "connected" || record.status === "ACTIVE";

const appOAuthRecordSchema = z.object({
  service: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()).optional(),
  sealedClientSecret: z.string().nullable().optional(),
  updatedAt: z.string(),
});

export type OpenConnectorAppOAuthRecord = z.infer<typeof appOAuthRecordSchema>;

const stateFileSchema = z.object({
  runtimeUrl: z.string().optional(),
  connections: z.array(connectionRecordSchema).optional(),
  appOAuth: z.array(appOAuthRecordSchema).optional(),
});

interface OpenConnectorStateStoreOptions {
  /** Test seam for asserting SQLite handle lifecycle; production uses node:sqlite directly. */
  createLockDatabase?: () => DatabaseSync;
  busyTimeoutMs?: number;
}

export class OpenConnectorStateStore {
  readonly file: string;
  private readonly runtimeUrl?: string;
  private readonly lockPath: string;
  private readonly createLockDatabase: () => DatabaseSync;
  private readonly busyTimeoutMs: number;
  private runtimeMismatch = false;
  private unreadableState = false;
  private loadedRuntimeUrl?: string;
  private connections: OpenConnectorConnectionRecord[];
  private appOAuth: OpenConnectorAppOAuthRecord[];

  constructor(
    file = join(DATA_DIR, OPENCONNECTOR_STATE_FILE),
    runtimeUrl?: string,
    options: OpenConnectorStateStoreOptions = {},
  ) {
    this.file = file;
    this.runtimeUrl = runtimeUrl?.trim() || undefined;
    this.lockPath = `${file}.lock.db`;
    this.createLockDatabase = options.createLockDatabase ?? (() => new DatabaseSync(this.lockPath));
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    const loaded = this.readUnlocked();
    this.runtimeMismatch = Boolean(this.runtimeUrl && loaded.runtimeUrl && loaded.runtimeUrl !== this.runtimeUrl);
    this.unreadableState = Boolean(loaded.unreadable);
    this.loadedRuntimeUrl = loaded.runtimeUrl;
    this.connections = loaded.connections;
    this.appOAuth = loaded.appOAuth;
  }

  private readUnlocked(): { runtimeUrl?: string; unreadable?: boolean; connections: OpenConnectorConnectionRecord[]; appOAuth: OpenConnectorAppOAuthRecord[] } {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connections: [], appOAuth: [] };
      return { unreadable: true, connections: [], appOAuth: [] };
    }
    try {
      const parsed = stateFileSchema.safeParse(parseJson(text));
      if (parsed.success) {
        if (this.runtimeUrl && parsed.data.runtimeUrl && parsed.data.runtimeUrl !== this.runtimeUrl) {
          return { runtimeUrl: parsed.data.runtimeUrl, connections: [], appOAuth: [] };
        }
        return { runtimeUrl: parsed.data.runtimeUrl, connections: parsed.data.connections ?? [], appOAuth: parsed.data.appOAuth ?? [] };
      }
    } catch {
    }
    return { unreadable: true, connections: [], appOAuth: [] };
  }

  private refreshUnlocked(): void {
    const loaded = this.readUnlocked();
    this.runtimeMismatch = Boolean(this.runtimeUrl && loaded.runtimeUrl && loaded.runtimeUrl !== this.runtimeUrl);
    this.unreadableState = Boolean(loaded.unreadable);
    this.loadedRuntimeUrl = loaded.runtimeUrl;
    this.connections = this.runtimeMismatch ? [] : loaded.connections;
    this.appOAuth = this.runtimeMismatch ? [] : loaded.appOAuth;
  }

  private lock(): DatabaseSync {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    const database = this.createLockDatabase();
    try {
      if (process.platform !== "win32" && (statSync(this.lockPath).mode & 0o777) !== 0o600) chmodSync(this.lockPath, 0o600);
      database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      database.exec("CREATE TABLE IF NOT EXISTS state_lock (id INTEGER PRIMARY KEY CHECK (id = 1))");
      return database;
    } catch (error) {
      try {
        database.close();
      } catch {}
      throw error;
    }
  }

  /** A SQLite exclusive transaction serializes hosts, threads and processes without path-unlink races.
   * Every read refreshes under it; every mutation refreshes first and persists before commit, so a
   * store bound to another runtime can read an empty view but can never overwrite the newer state. */
  private withLock<T>(operation: () => T, persist = true): T {
    const database = this.lock();
    let transactionStarted = false;
    try {
      database.exec("BEGIN EXCLUSIVE");
      transactionStarted = true;
      this.refreshUnlocked();
      if (persist && this.unreadableState) {
        throw new Error("Refusing to write OpenConnector state because the existing state file is unreadable or invalid");
      }
      if (persist && this.runtimeMismatch) {
        throw new Error("Refusing to write OpenConnector state for a different runtime URL");
      }
      const connectionsBefore = JSON.stringify(this.connections);
      const appOAuthBefore = JSON.stringify(this.appOAuth);
      const result = operation();
      if (persist && (JSON.stringify(this.connections) !== connectionsBefore || JSON.stringify(this.appOAuth) !== appOAuthBefore)) {
        this.persist();
      }
      database.exec("COMMIT");
      transactionStarted = false;
      return result;
    } finally {
      if (transactionStarted) {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
      try {
        database.close();
      } catch {}
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({
      ...(this.runtimeUrl ?? this.loadedRuntimeUrl ? { runtimeUrl: this.runtimeUrl ?? this.loadedRuntimeUrl } : {}),
      connections: this.connections,
      appOAuth: this.appOAuth,
    }), { mode: 0o600 });
  }

  listConnections(): OpenConnectorConnectionRecord[] {
    return this.withLock(() => this.connections.map((record) => ({ ...record })), false);
  }

  connectionsForService(service: string): OpenConnectorConnectionRecord[] {
    return this.withLock(() => this.connections
      .filter((record) => record.service === service)
      .map((record) => ({ ...record })), false);
  }

  findConnectionByAccountId(accountId: string): OpenConnectorConnectionRecord | null {
    return this.withLock(() => this.connections.find((record) => record.accountId === accountId) ?? null, false);
  }

  /** CAS for authorization convergence: the mutation sees the latest record inside the same lock and
   * can only replace that row. A replacement or deletion makes the expected request id stale, so no
   * stale poll can write or resurrect the connection. */
  updateConnectionIf(
    accountId: string,
    expectedConnectionRequestId: string | undefined,
    mutate: (record: OpenConnectorConnectionRecord) => OpenConnectorConnectionRecord | null | undefined,
  ): OpenConnectorConnectionRecord | null {
    return this.withLock(() => {
      const index = this.connections.findIndex((record) => record.accountId === accountId);
      if (index < 0) return null;
      const current = { ...this.connections[index] };
      if (current.connectionRequestId !== expectedConnectionRequestId) return null;
      const updated = mutate(current);
      if (!updated) return null;
      const next = { ...updated, accountId: current.accountId };
      this.connections[index] = next;
      return { ...next };
    });
  }

  upsertConnection(record: OpenConnectorConnectionRecord, expectedUpdatedAt?: string | null): void {
    this.withLock(() => {
      const index = this.connections.findIndex((existing) => existing.accountId === record.accountId);
      const existing = index >= 0 ? this.connections[index] : undefined;
      if (expectedUpdatedAt !== undefined && (existing?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error(`The OpenConnector connection ${record.accountId} was updated by another process`);
      }
      if (index >= 0) this.connections[index] = record;
      else this.connections.push(record);
    });
  }

  removeConnection(accountId: string): boolean {
    return this.withLock(() => {
      const before = this.connections.length;
      this.connections = this.connections.filter((record) => record.accountId !== accountId);
      return this.connections.length !== before;
    });
  }

  removeConnectionsForService(service: string): number {
    return this.withLock(() => {
      const before = this.connections.length;
      this.connections = this.connections.filter((record) => record.service !== service);
      return before - this.connections.length;
    });
  }

  listAppOAuth(): OpenConnectorAppOAuthRecord[] {
    return this.withLock(() => this.appOAuth.map((record) => ({ ...record })), false);
  }

  findAppOAuth(service: string): OpenConnectorAppOAuthRecord | null {
    return this.withLock(() => this.appOAuth.find((record) => record.service === service) ?? null, false);
  }

  upsertAppOAuth(record: OpenConnectorAppOAuthRecord, expectedUpdatedAt?: string | null): void {
    this.withLock(() => {
      const index = this.appOAuth.findIndex((existing) => existing.service === record.service);
      const existing = index >= 0 ? this.appOAuth[index] : undefined;
      if (expectedUpdatedAt !== undefined && (existing?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error(`The OpenConnector OAuth record for ${record.service} was updated by another process`);
      }
      if (index >= 0) this.appOAuth[index] = record;
      else this.appOAuth.push(record);
    });
  }

  /** Key file pattern from server/webhooks.ts sealKey: 0600, hex, regenerated only when absent. */
  private sealKey(create: boolean): Buffer | null {
    const path = join(dirname(this.file), CONNECTOR_KEY_FILE);
    try {
      const key = readFileSync(path, "utf8").trim();
      if (/^[a-f0-9]{64}$/u.test(key)) return Buffer.from(key, "hex");
    } catch {}
    if (!create) return null;
    const key = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${key.toString("hex")}\n`, { mode: 0o600 });
    return key;
  }

  sealSecret(secret: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey(true)!, nonce);
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
  }

  /** Null when the key is gone or the seal no longer matches; the plaintext never persists. */
  unsealSecret(sealed: string | undefined | null): string | null {
    const key = sealed ? this.sealKey(false) : null;
    if (!key || !sealed) return null;
    try {
      const data = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
