// What OpenMausBot keeps for an OpenConnector installation: connection aliases and labels that map
// to runtime connections, per-app OAuth client records whose secrets are sealed, and nothing else —
// credentials themselves live on the OpenConnector runtime. Sealing mirrors server/webhooks.ts: a
// random AES-256-GCM key in a 0600 file no backup carries (workspace-backup-policy excludes it).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

export class OpenConnectorStateStore {
  readonly file: string;
  private readonly runtimeUrl?: string;
  private connections: OpenConnectorConnectionRecord[];
  private appOAuth: OpenConnectorAppOAuthRecord[];

  constructor(file = join(DATA_DIR, OPENCONNECTOR_STATE_FILE), runtimeUrl?: string) {
    this.file = file;
    this.runtimeUrl = runtimeUrl?.trim() || undefined;
    const loaded = this.readUnlocked();
    this.connections = loaded.connections;
    this.appOAuth = loaded.appOAuth;
  }

  private readUnlocked(): { runtimeUrl?: string; connections: OpenConnectorConnectionRecord[]; appOAuth: OpenConnectorAppOAuthRecord[] } {
    try {
      const parsed = stateFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (parsed.success) {
        if (this.runtimeUrl && parsed.data.runtimeUrl && parsed.data.runtimeUrl !== this.runtimeUrl) {
          return { runtimeUrl: parsed.data.runtimeUrl, connections: [], appOAuth: [] };
        }
        return { runtimeUrl: parsed.data.runtimeUrl, connections: parsed.data.connections ?? [], appOAuth: parsed.data.appOAuth ?? [] };
      }
    } catch {
    }
    return { connections: [], appOAuth: [] };
  }

  private refreshUnlocked(): void {
    const loaded = this.readUnlocked();
    if (this.runtimeUrl && loaded.runtimeUrl && loaded.runtimeUrl !== this.runtimeUrl) return;
    this.connections = loaded.connections;
    this.appOAuth = loaded.appOAuth;
  }

  /** A 0600 lock file serializes processes. Every public read refreshes under it, and every mutation
   * refreshes before changing the current file, so a replacement provider cannot overwrite its update. */
  private withLock<T>(operation: () => T, persist = true): T {
    const path = `${this.file}.lock`;
    const deadline = Date.now() + 5_000;
    for (;;) {
      let descriptor: number;
      try {
        mkdirSync(dirname(path), { recursive: true });
        descriptor = openSync(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const now = Date.now();
        if (now >= deadline) throw new Error(`Timed out waiting for the OpenConnector state lock`);
        let owner: number | null = null;
        try {
          owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
        } catch {}
        const ownerAlive = owner !== null && Number.isSafeInteger(owner) && owner > 0 && process.kill(owner, 0);
        if (!ownerAlive) {
          try {
            unlinkSync(path);
            continue;
          } catch {}
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      try {
        writeFileSync(descriptor, `${process.pid}\n`, { flag: "r+" });
        this.refreshUnlocked();
        const result = operation();
        if (persist) this.persist();
        return result;
      } finally {
        closeSync(descriptor);
        try {
          unlinkSync(path);
        } catch {}
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({
      ...(this.runtimeUrl ? { runtimeUrl: this.runtimeUrl } : {}),
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

  upsertConnection(record: OpenConnectorConnectionRecord): void {
    this.withLock(() => {
      const index = this.connections.findIndex((existing) => existing.accountId === record.accountId);
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

  upsertAppOAuth(record: OpenConnectorAppOAuthRecord): void {
    this.withLock(() => {
      const index = this.appOAuth.findIndex((existing) => existing.service === record.service);
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
