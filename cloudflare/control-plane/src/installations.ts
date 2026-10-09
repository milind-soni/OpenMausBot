import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

import type { ControlPlaneAuth } from "./auth";
import { accountSession } from "./auth";
import { HTTPError, json, readBoundedJSON } from "./http";

interface InstallationRow {
  id: string;
  client_instance_id: string;
  display_name: string;
  platform: "darwin" | "windows" | "linux";
  app_version: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

interface OwnedInstallationRow extends InstallationRow {
  revoked_at: number | null;
}

interface InstallationCredentialRow {
  installation_id: string;
  lookup_id: string;
  secret_hash: string;
  display_name: string;
  client_instance_id: string;
  platform: "darwin" | "windows" | "linux";
  app_version: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  expires_at: number;
}

function printableString(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine((value) => {
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point === undefined || point < 32 || point === 127) return false;
    }
    return true;
  });
}

const printableName = printableString(80);
export const printableVersion = printableString(64);

const createInstallationSchema = z.strictObject({
  name: printableName,
  clientInstanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  platform: z.enum(["darwin", "windows", "linux"]),
  appVersion: printableVersion.optional(),
});

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_CREDENTIAL = /^omb_install_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const INSTALLATION_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const CREATION_RATE_WINDOW_MS = 60 * 60 * 1_000;
const CREATION_RATE_MAX_ATTEMPTS = 100;

function installationJSON(row: InstallationRow) {
  return {
    id: row.id,
    clientInstanceId: row.client_instance_id,
    name: row.display_name,
    platform: row.platform,
    appVersion: row.app_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function newCredential(createdAt: number) {
  const lookupId = base64URL(randomBytes(16));
  const secret = base64URL(randomBytes(32));
  const raw = `omb_install_${lookupId}.${secret}`;
  return {
    lookupId,
    raw,
    secretHash: await sha256(raw),
    expiresAt: createdAt + INSTALLATION_CREDENTIAL_TTL_MS,
  };
}

async function requireAccount(request: Request, auth: ControlPlaneAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

async function enforceCreationRateLimit(ownerUserId: string, env: Env): Promise<void> {
  const now = Date.now();
  const cutoff = now - CREATION_RATE_WINDOW_MS;
  const result = await env.DB.prepare(
    `INSERT INTO control_action_rate_limits
      (user_id, action, window_started_at, attempts, updated_at)
     VALUES (?, 'create_installation', ?, 1, ?)
     ON CONFLICT(user_id, action) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(
    ownerUserId,
    now,
    now,
    cutoff,
    cutoff,
    cutoff,
    CREATION_RATE_MAX_ATTEMPTS,
  ).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

export async function listInstallations(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  const result = await env.DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at
       FROM installations
      WHERE owner_user_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 100`,
  ).bind(session.user.id).all<InstallationRow>();
  return json({ installations: result.results.map(installationJSON) });
}

export async function createInstallation(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  await enforceCreationRateLimit(session.user.id, env);
  const parsed = createInstallationSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");

  const installationId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const credential = await newCredential(now);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installations
          (id, owner_user_id, client_instance_id, display_name, platform, app_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        installationId,
        session.user.id,
        parsed.data.clientInstanceId,
        parsed.data.name,
        parsed.data.platform,
        parsed.data.appVersion ?? null,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO installation_credentials
          (id, installation_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(credentialId, installationId, credential.lookupId, credential.secretHash, now, credential.expiresAt),
    ]);
  } catch (error) {
    if (error instanceof Error && /active_installation_limit/i.test(error.message)) {
      throw new HTTPError(409, "installation_limit_reached");
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new HTTPError(409, "installation_exists");
    }
    throw error;
  }

  return json({
    installation: {
      id: installationId,
      clientInstanceId: parsed.data.clientInstanceId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion ?? null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    },
    credential: credential.raw,
    credentialExpiresAt: credential.expiresAt,
  }, 201);
}

async function ownedActiveInstallation(id: string, ownerUserId: string, env: Env) {
  if (!INSTALLATION_ID.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at
       FROM installations
      WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
  ).bind(id, ownerUserId).first<InstallationRow>();
}

async function ownedInstallation(id: string, ownerUserId: string, env: Env) {
  if (!INSTALLATION_ID.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at, revoked_at
       FROM installations
      WHERE id = ? AND owner_user_id = ?`,
  ).bind(id, ownerUserId).first<OwnedInstallationRow>();
}

export async function rotateInstallationCredential(
  request: Request,
  installationId: string,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const installation = await ownedActiveInstallation(installationId, session.user.id, env);
  if (!installation) throw new HTTPError(404, "not_found");

  const now = Date.now();
  const credential = await newCredential(now);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE installations
            SET updated_at = ?, last_rotation_at = ?
          WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      ).bind(now, now, installationId, session.user.id),
      env.DB.prepare(
        `UPDATE installation_credentials
            SET revoked_at = ?
          WHERE installation_id = ? AND revoked_at IS NULL`,
      ).bind(now, installationId),
      env.DB.prepare(
        `INSERT INTO installation_credentials
          (id, installation_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        installationId,
        credential.lookupId,
        credential.secretHash,
        now,
        credential.expiresAt,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /credential_rotation_rate_limited/i.test(error.message)) {
      throw new HTTPError(429, "credential_rotation_rate_limited");
    }
    if (error instanceof Error && /credential_rotation_conflict/i.test(error.message)) {
      throw new HTTPError(409, "credential_rotation_conflict");
    }
    throw error;
  }
  return json({ credential: credential.raw, createdAt: now, credentialExpiresAt: credential.expiresAt }, 201);
}

export async function revokeInstallation(
  request: Request,
  installationId: string,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const installation = await ownedInstallation(installationId, session.user.id, env);
  if (!installation) throw new HTTPError(404, "not_found");

  if (installation.revoked_at === null) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE installations SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, now, installationId),
      env.DB.prepare(
        "UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL",
      ).bind(now, installationId),
    ]);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function authenticateInstallation(request: Request, env: Env): Promise<InstallationCredentialRow | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const parsed = bearer?.match(INSTALLATION_CREDENTIAL);
  if (!bearer || !parsed) return null;

  const row = await env.DB.prepare(
    `SELECT c.installation_id, c.lookup_id, c.secret_hash, c.expires_at,
            i.display_name, i.client_instance_id, i.platform, i.app_version,
            i.created_at, i.updated_at, i.last_seen_at
       FROM installation_credentials c
       JOIN installations i ON i.id = c.installation_id
      WHERE c.lookup_id = ?
        AND c.revoked_at IS NULL
        AND c.expires_at > ?
        AND i.revoked_at IS NULL`,
  ).bind(parsed[1], Date.now()).first<InstallationCredentialRow>();
  if (!row) return null;

  const expected = fromHex(row.secret_hash);
  if (!expected) return null;
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
  if (!timingSafeEqual(actual, expected)) return null;
  return row;
}

export async function requireInstallation(
  request: Request,
  env: Env,
): Promise<InstallationCredentialRow> {
  return (await requireInstallationAndRead(request, env, null)).installation;
}

/** Authenticates the installation and records that it was seen. An optional
 * read of its own data rides in the same D1 batch, saving a round trip. */
export async function requireInstallationAndRead<T>(
  request: Request,
  env: Env,
  read: ((installationId: string) => D1PreparedStatement) | null,
): Promise<{ installation: InstallationCredentialRow; row: T | null }> {
  const installation = await authenticateInstallation(request, env);
  if (!installation) throw new HTTPError(401, "unauthorized");

  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `UPDATE installation_credentials
          SET last_used_at = ?
        WHERE lookup_id = ? AND revoked_at IS NULL`,
    ).bind(now, installation.lookup_id),
    env.DB.prepare(
      `UPDATE installations
          SET last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
    ).bind(now, installation.installation_id),
  ];
  // The read runs after the writes, as it did as a separate query. A batch is
  // one transaction, so if the read fails the check-in rolls back with it.
  if (read) statements.push(read(installation.installation_id));
  const results = await env.DB.batch(statements);
  installation.last_seen_at = now;
  // The UPDATEs return no rows. When a read is batched, its result is last.
  const row = read ? ((results.at(-1)?.results[0] as T | undefined) ?? null) : null;
  return { installation, row };
}

/** Keeps `app_version` current: registration is not the only time an app
 * says which release it runs, and endpoint allocation can depend on it. The
 * caller has already compared it with the stored value. */
export async function recordReportedAppVersion(
  env: Env,
  installationId: string,
  appVersion: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE installations SET app_version = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(appVersion, installationId).run();
}

export async function installationSelf(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  return json({
    installation: {
      id: installation.installation_id,
      clientInstanceId: installation.client_instance_id,
      name: installation.display_name,
      platform: installation.platform,
      appVersion: installation.app_version,
      createdAt: installation.created_at,
      updatedAt: installation.updated_at,
      lastSeenAt: installation.last_seen_at,
    },
    credentialExpiresAt: installation.expires_at,
  });
}
