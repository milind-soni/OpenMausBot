// What OpenMausBot keeps for an OpenConnector installation: connection aliases and labels that map
// to runtime connections, per-app OAuth client records whose secrets are sealed, and nothing else —
// credentials themselves live on the OpenConnector runtime. Sealing mirrors server/webhooks.ts: a
// random AES-256-GCM key in a 0600 file no backup carries (workspace-backup-policy excludes it).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
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

const LOCK_TIMEOUT_MS = 1_000;
const STALE_LOCK_AGE_MS = 5_000;

function acquireStateLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let cause: unknown;
  do {
    try {
      const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(descriptor);
      return () => {
        try { unlinkSync(path); } catch {}
      };
    } catch (error: unknown) {
      cause = error;
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_AGE_MS) unlinkSync(path);
      } catch {}
    }
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for the OpenConnector state lock: ${cause instanceof Error ? cause.message : "locked"}`);
}

export class OpenConnectorStateStore {
  readonly file: string;
  private readonly runtimeUrl?: string;
  private connections: OpenConnectorConnectionRecord[];
  private appOAuth: OpenConnectorAppOAuthRecord[];

  constructor(file = join(DATA_DIR, OPENCONNECTOR_STATE_FILE), runtimeUrl?: string) {
    this.file = file;
    this.runtimeUrl = runtimeUrl?.trim() || undefined;
    const loaded = this.read();
    this.connections = loaded.connections;
    this.appOAuth = loaded.appOAuth;
  }

  private read(): { connections: OpenConnectorConnectionRecord[]; appOAuth: OpenConnectorAppOAuthRecord[] } {
    try {
      const parsed = stateFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (parsed.success) {
        if (this.runtimeUrl && parsed.data.runtimeUrl && parsed.data.runtimeUrl !== this.runtimeUrl) {
          return { connections: [], appOAuth: [] };
        }
        return { connections: parsed.data.connections ?? [], appOAuth: parsed.data.appOAuth ?? [] };
      }
    } catch {
    }
    return { connections: [], appOAuth: [] };
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({
      ...(this.runtimeUrl ? { runtimeUrl: this.runtimeUrl } : {}),
      connections: this.connections,
      appOAuth: this.appOAuth,
    }), { mode: 0o600 });
  }

  private locked<T>(operation: (fresh: { connections: OpenConnectorConnectionRecord[]; appOAuth: OpenConnectorAppOAuthRecord[] }) => {
    result: T;
    connections?: OpenConnectorConnectionRecord[];
    appOAuth?: OpenConnectorAppOAuthRecord[];
  }): T {
    const unlock = acquireStateLock(`${this.file}.lock`);
    try {
      const fresh = this.read();
      const next = operation(fresh);
      this.connections = next.connections ?? fresh.connections;
      this.appOAuth = next.appOAuth ?? fresh.appOAuth;
      if (next.connections || next.appOAuth) this.persist();
      return next.result;
    } finally {
      unlock();
    }
  }

  listConnections(): OpenConnectorConnectionRecord[] {
    return this.locked((fresh) => ({ result: fresh.connections.map((record) => ({ ...record })) }));
  }

  connectionsForService(service: string): OpenConnectorConnectionRecord[] {
    return this.listConnections().filter((record) => record.service === service);
  }

  findConnectionByAccountId(accountId: string): OpenConnectorConnectionRecord | null {
    return this.locked((fresh) => ({
      result: fresh.connections.find((record) => record.accountId === accountId) ?? null,
    }));
  }

  upsertConnection(record: OpenConnectorConnectionRecord, expectedUpdatedAt?: string | null): void {
    this.locked((fresh) => {
      const connections = [...fresh.connections];
      const index = connections.findIndex((existing) => existing.accountId === record.accountId);
      const existing = index >= 0 ? connections[index] : undefined;
      if (expectedUpdatedAt !== undefined && (existing?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error(`The OpenConnector connection ${record.accountId} was updated by another process`);
      }
      if (index >= 0) connections[index] = record;
      else connections.push(record);
      return { result: undefined, connections };
    });
  }

  removeConnection(accountId: string): boolean {
    return this.locked((fresh) => {
      const connections = fresh.connections.filter((record) => record.accountId !== accountId);
      return { result: connections.length !== fresh.connections.length, connections };
    });
  }

  removeConnectionsForService(service: string): number {
    return this.locked((fresh) => {
      const connections = fresh.connections.filter((record) => record.service !== service);
      return { result: fresh.connections.length - connections.length, connections };
    });
  }

  listAppOAuth(): OpenConnectorAppOAuthRecord[] {
    return this.locked((fresh) => ({ result: fresh.appOAuth.map((record) => ({ ...record })) }));
  }

  findAppOAuth(service: string): OpenConnectorAppOAuthRecord | null {
    return this.locked((fresh) => ({
      result: fresh.appOAuth.find((record) => record.service === service) ?? null,
    }));
  }

  upsertAppOAuth(record: OpenConnectorAppOAuthRecord, expectedUpdatedAt?: string | null): void {
    this.locked((fresh) => {
      const appOAuth = [...fresh.appOAuth];
      const index = appOAuth.findIndex((existing) => existing.service === record.service);
      const existing = index >= 0 ? appOAuth[index] : undefined;
      if (expectedUpdatedAt !== undefined && (existing?.updatedAt ?? null) !== expectedUpdatedAt) {
        throw new Error(`The OpenConnector OAuth record for ${record.service} was updated by another process`);
      }
      if (index >= 0) appOAuth[index] = record;
      else appOAuth.push(record);
      return { result: undefined, appOAuth };
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
