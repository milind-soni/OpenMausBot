#!/usr/bin/env node
// One-time import of a retired ORIGIN_LOCAL_DATA_DIR (/data/origin) into Convex.
//
//   node scripts/migrate-local-store-to-convex.ts <data-dir> [--dry-run | --apply] [--offline]
//        [--convex-site-url https://<deployment>.convex.site] [--legacy-workspace-id <teamId>]
//
// Dry run is the default and never writes: not to Convex and not to <data-dir> (the sqlite files are read from a
// temporary copy). With ORIGIN_INTEGRATION_SECRET and a Convex site URL (--convex-site-url or
// NEXT_PUBLIC_CONVEX_SITE_URL) it asks Convex, read-only, which rows it already holds and prints planned inserts,
// updates, skips and deletes; with --offline (or without them) it prints source counts only. --apply writes, through
// the signed /integrations action, and is idempotent: every row is upserted by its old primary key, so re-running
// inserts nothing twice.
//
// Secrets: rows sealed with the old integrations.key are opened here and sent to Convex, which seals them again with
// ORIGIN_SEALING_KEY under their original purpose; neither key nor any plaintext is printed or written to disk.
// runner-signing.key is never sent anywhere: the script checks it and prints the Convex env var to set by hand.

import { createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export type Item = Record<string, unknown>;
export type Transport = (operation: string, args: Record<string, unknown>) => Promise<unknown>;
export type Upload = (bytes: Uint8Array, contentType: string) => Promise<string>;
type Status = "absent" | "same" | "different";
type Batch = { source: string; kind: string; items: Item[]; skipped: number; note?: string };
export type ReportRow = { source: string; kind: string; rows: number; insert: number; update: number; skip: number; delete: number; note?: string };
export type Report = { mode: "dry-run" | "apply"; compared: boolean; rows: ReportRow[]; ignored: string[]; notes: string[] };

export class MigrationError extends Error {}

/** Marker a successful --apply leaves in Convex (localStoreMarkers). */
export const COMPLETED = "local-store-import:completed";

// ---- Reading the old store ----

/** Opens a temporary copy of a sqlite file (with its WAL), so reading never touches the source. */
function openCopy(file: string, scratch: string) {
  if (!existsSync(file)) return null;
  const target = path.join(scratch, path.basename(file));
  copyFileSync(file, target);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(file + suffix)) copyFileSync(file + suffix, target + suffix);
  return new DatabaseSync(target);
}
function tables(db: DatabaseSync) {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
}
function rows(db: DatabaseSync | null, table: string): Record<string, unknown>[] {
  if (!db || !tables(db).has(table)) return [];
  return db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
}
const str = (value: unknown) => value === null || value === undefined ? "" : String(value);
const num = (value: unknown) => Number(value ?? 0);

/** AES-256-GCM as lib/githubConnection.ts sealed it before this release: base64(iv[12] | tag[16] | ciphertext). */
export function openLegacySealed(key: Buffer, value: string, purpose: string) {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

const parseJson = (text: unknown) => { try { return JSON.parse(str(text)) as unknown; } catch { return text; } };

/** Paths of every field whose name says it holds a sealed value, so none can slip into Convex under the old key. */
function sealedPaths(value: unknown, at: string[] = []): string[][] {
  if (!value || typeof value !== "object") return [];
  const found: string[][] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(sealed|encrypted)/i.test(key) && typeof child === "string") found.push([...at, key]);
    else found.push(...sealedPaths(child, [...at, key]));
  }
  return found;
}
function getPath(value: unknown, at: string[]) {
  return at.reduce<unknown>((node, key) => node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, value);
}

/** Known sealed fields in execution.sqlite rows (from the runner code removed in 87ea4f5f8) and their purposes. */
function executionSecrets(table: string, row: Record<string, unknown>, payload: unknown): { path: string[]; purpose: string }[] {
  const at = (...keys: string[]) => ["payload", ...keys];
  if (table === "execution_runs") return [
    { path: at("sealedEnvironment"), purpose: `execution-env:${str(row.id)}` },
    { path: at("sealedGitCredential"), purpose: `execution-git:${str(row.id)}` },
  ].filter(secret => typeof getPath({ payload }, secret.path) === "string");
  if (table === "execution_settings" && row.kind === "environment") return [{ path: at("sealed"), purpose: `execution-environment:${str(row.team_id)}:${str(row.reference)}` }].filter(secret => typeof getPath({ payload }, secret.path) === "string");
  if (table === "execution_settings" && row.kind === "cloud") return [{ path: at("sealedKey"), purpose: `execution-cloud:${str(row.team_id)}:${str(row.reference)}` }].filter(secret => typeof getPath({ payload }, secret.path) === "string");
  if (table === "execution_cloud") return [{ path: at("enrollment", "sealedToken"), purpose: `cloud-enrollment:${str(row.id)}` }].filter(secret => typeof getPath({ payload }, secret.path) === "string");
  return [];
}

const EXECUTION_KEYS: Record<string, string[]> = {
  execution_accounts: ["account_id", "host_id", "local_id"], execution_audit: ["id"], execution_cloud: ["id"], execution_controls: ["id"],
  execution_enrollments: ["hash"], execution_events: ["id"], execution_hosts: ["id"], execution_runs: ["id"], execution_settings: ["team_id", "kind", "reference"],
};

export type LocalStore = {
  batches: Batch[];
  files: { teamId: string; conversation: string; fileId: string; author: string; payload: string; bytes: Uint8Array; contentType: string }[];
  /** Teams whose chat the old store copied from Convex: the local copy is authoritative for them. */
  authoritativeTeams: string[];
  localMessageIds: Map<string, Set<string>>;
  outbox: Item[];
  revocations: string[];
  ignored: string[];
  notes: string[];
};

/** Reads a /data/origin-shaped directory into import batches. Opens every sealed value, so a wrong key fails here. */
export function readLocalStore(dir: string, options: { legacyWorkspaceId?: string; now?: number } = {}): LocalStore {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new MigrationError(`${dir} is not a directory`);
  const now = options.now ?? Date.now();
  const scratch = mkdtempSync(path.join(tmpdir(), "origin-store-import-"));
  try {
    const origin = openCopy(path.join(dir, "origin.sqlite"), scratch);
    const integrations = openCopy(path.join(dir, "integrations.sqlite"), scratch);
    const execution = openCopy(path.join(dir, "execution.sqlite"), scratch);
    const store: LocalStore = { batches: [], files: [], authoritativeTeams: [], localMessageIds: new Map(), outbox: [], revocations: [], ignored: [], notes: [] };
    const add = (source: string, kind: string, items: Item[], skipped = 0, note?: string) => store.batches.push({ source, kind, items, skipped, ...(note ? { note } : {}) });

    // Key material. integrations.key only opens old ciphertext here; it is never sent or kept.
    const keyFile = path.join(dir, "integrations.key");
    const key = existsSync(keyFile) ? readFileSync(keyFile) : null;
    if (key && key.length !== 32) throw new MigrationError("integrations.key must be 32 bytes");
    const open = (value: unknown, purpose: string, what: string) => {
      if (!key) throw new MigrationError(`${what} is sealed but integrations.key is missing`);
      try { return openLegacySealed(key, str(value), purpose); }
      catch { throw new MigrationError(`${what} cannot be opened with integrations.key (wrong key or corrupted row)`); }
    };

    // origin.sqlite
    const messages = rows(origin, "messages");
    const markers = rows(origin, "migrations").map(row => str(row.name));
    for (const message of messages) {
      const id = `${str(message.team)}\n${str(message.conversation)}`;
      if (!store.localMessageIds.has(id)) store.localMessageIds.set(id, new Set());
      store.localMessageIds.get(id)!.add(str(message.id));
    }
    add("origin.messages", "chatMessage", messages.map(row => ({ teamId: str(row.team), conversation: str(row.conversation), messageId: str(row.id), created: num(row.created), payload: str(row.payload) })));
    const realtime = path.join(dir, "realtime.json");
    if (existsSync(realtime)) {
      if (markers.includes("legacy-chat")) store.notes.push("realtime.json was already imported into origin.sqlite (migration legacy-chat); skipped.");
      else if (!options.legacyWorkspaceId) store.notes.push("realtime.json is present but was never imported; pass --legacy-workspace-id <teamId> to import it.");
      else {
        const legacy = (JSON.parse(readFileSync(realtime, "utf8")).messages || []) as { id: string; createdAt: number }[];
        add("realtime.json", "chatMessage", legacy.map(message => ({ teamId: options.legacyWorkspaceId!, conversation: "", messageId: message.id, created: message.createdAt, payload: JSON.stringify(message) })));
      }
    }
    add("origin.direct_conversations", "chatDirect", rows(origin, "direct_conversations").map(row => ({ teamId: str(row.team), conversation: str(row.id), userA: str(row.user_a), userB: str(row.user_b) })));
    add("origin.chat_reads", "chatRead", rows(origin, "chat_reads").map(row => ({ teamId: str(row.team), conversation: str(row.conversation), userId: str(row.user), seen: num(row.seen) })));
    for (const row of rows(origin, "files")) {
      const fileId = str(row.id);
      const file = path.join(dir, "files", fileId);
      if (!/^[a-f0-9-]{36}$/.test(fileId) || !existsSync(file)) { store.notes.push(`Attachment ${fileId || "(blank id)"} has no file in files/; its metadata row is skipped.`); continue; }
      const payload = parseJson(row.payload) as { contentType?: string };
      store.files.push({ teamId: str(row.team), conversation: str(row.conversation), fileId, author: str(row.author), payload: str(row.payload), bytes: new Uint8Array(readFileSync(file)), contentType: payload?.contentType || "application/octet-stream" });
    }
    add("origin.migrations", "marker", markers.map(name => ({ name })));
    store.authoritativeTeams = markers.filter(name => name.startsWith("convex-chat:")).map(name => name.slice("convex-chat:".length));
    const limits = rows(origin, "request_limits");
    const liveLimits = limits.filter(row => num(row.expires) >= now);
    add("origin.request_limits", "requestLimit", liveLimits.map(row => ({ key: str(row.key), count: num(row.count), expiresAt: num(row.expires) })), limits.length - liveLimits.length, "expired windows are skipped");
    store.outbox = rows(origin, "notification_outbox").map(row => parseJson(row.payload) as Item);
    for (const table of ["participants", "signals"]) { const count = rows(origin, table).length; if (count) store.notes.push(`origin.${table}: ${count} ephemeral call rows are not imported (they expire within two minutes).`); }

    // integrations.sqlite
    add("integrations.github_app", "githubApp", rows(integrations, "github_app").map(row => ({ plain: open(row.encrypted, "github-app", "github_app") })));
    add("integrations.github_connections", "githubProject", rows(integrations, "github_connections").map(row => ({
      projectId: str(row.project), repo: str(row.repo), login: str(row.login), connectedBy: str(row.connected_by), updatedAt: num(row.updated),
      plain: open(row.encrypted, `${str(row.project)}:${str(row.repo)}`, "github_connections"),
    })));
    add("integrations.github_workspace", "githubWorkspace", rows(integrations, "github_workspace").map(row => ({
      teamId: str(row.team), login: str(row.login), accountId: num(row.account_id), connectedBy: str(row.connected_by),
      plain: open(row.encrypted, `github-team:${str(row.team)}`, "github_workspace"),
    })));
    const states = rows(integrations, "github_oauth_states"), liveStates = states.filter(row => num(row.expires) > now);
    add("integrations.github_oauth_states", "githubState", liveStates.map(row => ({ stateHash: str(row.hash), browserHash: str(row.browser_hash), expiresAt: num(row.expires), plain: open(row.encrypted, `github-state:${str(row.hash)}`, "github_oauth_states") })), states.length - liveStates.length, "expired states are skipped");
    add("integrations.github_jobs", "githubJob", rows(integrations, "github_jobs").map(row => ({ key: str(row.key), state: str(row.state), ...(row.payload === null ? {} : { payload: str(row.payload) }), updatedAt: num(row.updated) })));
    add("integrations.instance_operator", "archive", rows(integrations, "instance_operator").map(row => ({ source: "integrations.instance_operator", key: str(row.id), payload: JSON.stringify(row), secrets: [] })));
    add("integrations.mcp_clients", "mcpClient", rows(integrations, "mcp_clients").map(row => ({ clientId: str(row.id), name: str(row.name), redirects: str(row.redirects), createdAt: num(row.created) })));
    add("integrations.mcp_grants", "mcpGrant", rows(integrations, "mcp_grants").map(row => ({
      grantId: str(row.id), clientId: str(row.client), scope: str(row.scope), resource: str(row.resource), expiresAt: num(row.expires), revoked: num(row.revoked) === 1,
      plain: open(row.encrypted, `mcp:${str(row.id)}`, "mcp_grants"),
    })));
    add("integrations.mcp_codes", "mcpCode", rows(integrations, "mcp_codes").map(row => ({ codeHash: str(row.hash), grantId: str(row.grant_id), redirect: str(row.redirect), challenge: str(row.challenge), expiresAt: num(row.expires), used: num(row.used) === 1 })));
    add("integrations.mcp_tokens", "mcpToken", rows(integrations, "mcp_tokens").map(row => ({ tokenHash: str(row.hash), grantId: str(row.grant_id), kind: str(row.kind), expiresAt: num(row.expires), used: num(row.used) === 1, ...(row.scope === null ? {} : { scope: str(row.scope) }) })));
    store.revocations = rows(integrations, "mcp_revocations").map(row => open(row.encrypted, `mcp:${str(row.grant_id)}`, "mcp_revocations"));
    add("integrations.agent_invite_deliveries", "invite", rows(integrations, "agent_invite_deliveries").map(row => ({ deliveryId: str(row.id), sent: num(row.sent) === 1 })));

    // execution.sqlite: no current code reads it; every row is kept in localStoreArchive with its secrets re-sealed.
    for (const [table, keyColumns] of Object.entries(EXECUTION_KEYS)) {
      const items = rows(execution, table).map(row => {
        const payload = "payload" in row ? parseJson(row.payload) : undefined;
        const record = { ...row, ...(payload === undefined ? {} : { payload }) };
        const secrets = executionSecrets(table, row, payload);
        const known = new Set(secrets.map(secret => secret.path.join(".")));
        const unknown = sealedPaths(record).filter(at => !known.has(at.join(".")));
        if (unknown.length) throw new MigrationError(`execution.${table} has sealed fields this script does not know how to re-seal: ${unknown.map(at => at.join(".")).join(", ")}`);
        return {
          source: `execution.${table}`, key: JSON.stringify(keyColumns.map(column => row[column] === null ? null : str(row[column]))),
          ...(row.team_id ? { teamId: str(row.team_id) } : {}), payload: JSON.stringify(record),
          secrets: secrets.map(secret => ({ ...secret, plain: open(getPath(record, secret.path), secret.purpose, `execution.${table}`) })),
        };
      });
      add(`execution.${table}`, "archive", items);
    }
    const locks = rows(execution, "execution_locks"), liveLocks = locks.filter(row => num(row.expires) >= now);
    add("execution.execution_locks", "lease", liveLocks.map(row => ({ name: `execution:${str(row.name)}`, owner: str(row.owner), expiresAt: num(row.expires) })), locks.length - liveLocks.length, "expired leases are skipped");

    // Files that are not runtime state.
    for (const entry of readdirSync(dir)) {
      if (["origin.sqlite", "integrations.sqlite", "execution.sqlite", "integrations.key", "runner-signing.key", "files", "realtime.json"].includes(entry)) continue;
      if (/\.sqlite-(wal|shm|journal)$/.test(entry)) continue;
      store.ignored.push(statSync(path.join(dir, entry)).isDirectory() ? `${entry}/` : entry);
    }
    const signing = path.join(dir, "runner-signing.key");
    if (existsSync(signing)) {
      let fingerprint: string;
      try {
        const privateKey = createPrivateKey(readFileSync(signing));
        if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
        fingerprint = createHash("sha256").update(createPublicKey(privateKey).export({ type: "spki", format: "der" })).digest("hex");
      } catch { throw new MigrationError("runner-signing.key is not an Ed25519 private key"); }
      store.notes.push(`runner-signing.key: Ed25519, public key SHA-256 ${fingerprint}. It is not imported into any table. Set it by hand as the Convex env var ORIGIN_RUNNER_SIGNING_KEY (base64 of the PEM file) so coding runners keep trusting the same release key.`);
    }
    if (key) store.notes.push("integrations.key: used only to open old ciphertext; everything was re-sealed by Convex with ORIGIN_SEALING_KEY. Keep it offline until the import is verified, then destroy it.");
    for (const db of [origin, integrations, execution]) db?.close();
    return store;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// ---- Talking to Convex ----

/** The signed /integrations call lib/integration-bridge.ts makes, with the deployment's ORIGIN_INTEGRATION_SECRET. */
export function signedTransport(siteUrl: string, secret: string): Transport {
  if (!secret || secret.length < 32) throw new MigrationError("Set ORIGIN_INTEGRATION_SECRET (the value in the Convex deployment's env)");
  const site = new URL(siteUrl).origin;
  return async (operation, args) => {
    const body = JSON.stringify({ at: Date.now(), operation, args });
    const response = await fetch(`${site}/integrations`, { method: "POST", body, headers: { "Content-Type": "application/json", "x-origin-signature": createHmac("sha256", secret).update(body).digest("hex") }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new MigrationError(`Convex rejected ${operation} (${response.status})`);
    return response.json();
  };
}
export function storageUpload(transport: Transport): Upload {
  return async (bytes, contentType) => {
    const url = await transport("migrate.uploadUrl", {}) as string;
    const response = await fetch(url, { method: "POST", body: bytes as BodyInit, headers: { "Content-Type": contentType }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new MigrationError(`File upload failed (${response.status})`);
    return (await response.json() as { storageId: string }).storageId;
  };
}

const keysOnly = (item: Item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "plain" && key !== "secrets"));
function chunks(items: Item[], limit = 50000) {
  const out: Item[][] = [];
  let current: Item[] = [], size = 0;
  for (const item of items) {
    const length = JSON.stringify(item).length;
    if (length > 90000) throw new MigrationError("A row is larger than the 100 kB bridge limit");
    if (current.length && (size + length > limit || current.length >= 100)) { out.push(current); current = []; size = 0; }
    current.push(item); size += length;
  }
  if (current.length) out.push(current);
  return out;
}

async function inspect(transport: Transport, kind: string, items: Item[]) {
  const statuses: Status[] = [];
  for (const chunk of chunks(items.map(keysOnly))) statuses.push(...await transport("migrate.inspect", { kind, items: chunk }) as Status[]);
  return statuses;
}

/** Convex message ids the local store deleted after copying a team's chat from Convex. */
async function plannedDeletes(transport: Transport, store: LocalStore) {
  const deletes: { teamId: string; conversation: string; messageIds: string[] }[] = [];
  for (const teamId of store.authoritativeTeams) {
    const conversations = new Set([""]);
    for (const batch of store.batches) if (batch.kind === "chatDirect") for (const item of batch.items) if (item.teamId === teamId) conversations.add(String(item.conversation));
    for (const conversation of conversations) {
      const local = store.localMessageIds.get(`${teamId}\n${conversation}`) ?? new Set<string>();
      const stale: string[] = [];
      for (let cursor: string | null = null; ;) {
        const page = await transport("migrate.chatMessageIds", { teamId, conversation, cursor }) as { ids: string[]; isDone: boolean; continueCursor: string };
        stale.push(...page.ids.filter(id => !local.has(id)));
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      if (stale.length) deletes.push({ teamId, conversation, messageIds: stale });
    }
  }
  return deletes;
}

export async function migrate(dir: string, options: { apply: boolean; transport?: Transport; upload?: Upload; legacyWorkspaceId?: string; log?: (line: string) => void; now?: number }): Promise<Report> {
  const log = options.log ?? (() => {});
  const store = readLocalStore(dir, options);
  const transport = options.transport;
  if (options.apply && !transport) throw new MigrationError("--apply needs ORIGIN_INTEGRATION_SECRET and a Convex site URL");
  const report: Report = { mode: options.apply ? "apply" : "dry-run", compared: Boolean(transport), rows: [], ignored: store.ignored, notes: store.notes };
  if (transport && (await inspect(transport, "marker", [{ name: COMPLETED }]))[0] !== "absent") {
    store.notes.unshift("An earlier --apply already completed. Re-run only while the old frontend is still the only writer: once the new frontend serves traffic, a stale local store could bring back GitHub connections or MCP grants removed since. Chat the new frontend wrote is never changed by the import.");
  }
  const row = (source: string, kind: string, rows: number, note?: string): ReportRow => { const entry = { source, kind, rows, insert: 0, update: 0, skip: 0, delete: 0, ...(note ? { note } : {}) }; report.rows.push(entry); return entry; };

  for (const batch of store.batches) {
    const entry = row(batch.source, batch.kind, batch.items.length + batch.skipped, batch.skipped ? batch.note : undefined);
    entry.skip += batch.skipped;
    if (!batch.items.length) continue;
    if (!transport) { entry.insert += batch.items.length; continue; }
    if (!options.apply) {
      for (const status of await inspect(transport, batch.kind, batch.items)) entry[status === "absent" ? "insert" : status === "different" ? "update" : "skip"] += 1;
      continue;
    }
    for (const chunk of chunks(batch.items)) {
      const result = await transport("migrate.apply", { kind: batch.kind, items: chunk }) as { inserted: number; updated: number; skipped: number };
      entry.insert += result.inserted; entry.update += result.updated; entry.skip += result.skipped;
    }
    log(`${batch.source}: ${entry.insert} inserted, ${entry.update} updated, ${entry.skip} skipped`);
  }

  const files = row("origin.files + files/", "chatFile", store.files.length);
  if (store.files.length) {
    if (!transport) files.insert = store.files.length;
    else {
      const statuses = await inspect(transport, "chatFile", store.files.map(file => ({ teamId: file.teamId, conversation: file.conversation, fileId: file.fileId })));
      for (const [index, file] of store.files.entries()) {
        if (statuses[index] !== "absent") { files.skip += 1; continue; }
        if (!options.apply) { files.insert += 1; continue; }
        const storageId = await (options.upload ?? storageUpload(transport))(file.bytes, file.contentType);
        const result = await transport("migrate.apply", { kind: "chatFile", items: [{ teamId: file.teamId, conversation: file.conversation, fileId: file.fileId, author: file.author, payload: file.payload, storageId }] }) as { inserted: number; skipped: number };
        files.insert += result.inserted; files.skip += result.skipped;
      }
    }
  }

  const prune = row("origin.messages deleted after the Convex copy", "chatMessage", 0, store.authoritativeTeams.length ? `teams copied from Convex: ${store.authoritativeTeams.length}` : undefined);
  if (transport) {
    for (const plan of await plannedDeletes(transport, store)) {
      if (!options.apply) { prune.delete += plan.messageIds.length; continue; }
      for (let start = 0; start < plan.messageIds.length; start += 200) prune.delete += await transport("migrate.deleteChatMessages", { ...plan, messageIds: plan.messageIds.slice(start, start + 200) }) as number;
    }
  } else if (store.authoritativeTeams.length) prune.note = "not compared (offline)";

  const outbox = row("origin.notification_outbox", "notifyMentions", store.outbox.length, store.outbox.length ? "delivered once; notifications de-duplicate per message" : undefined);
  outbox.insert = store.outbox.length;
  if (options.apply && store.outbox.length) await transport!("migrate.notifyMentions", { items: store.outbox });
  const revocations = row("integrations.mcp_revocations", "revokeConnector", store.revocations.length);
  revocations.update = store.revocations.length;
  if (options.apply) for (const connectorToken of store.revocations) await transport!("migrate.revokeConnector", { connectorToken });
  if (options.apply) await transport!("migrate.apply", { kind: "marker", items: [{ name: COMPLETED }] });
  return report;
}

export function formatReport(report: Report) {
  const lines = [`Origin local store import: ${report.mode}${report.compared ? " (compared with Convex)" : " (offline: source counts only, nothing compared)"}`, ""];
  const head = ["source", "kind", "rows", report.mode === "apply" ? "inserted" : "insert", report.mode === "apply" ? "updated" : "update", report.mode === "apply" ? "skipped" : "skip", "delete"];
  const table = [head, ...report.rows.map(row => [row.source, row.kind, String(row.rows), String(row.insert), String(row.update), String(row.skip), String(row.delete)])];
  const widths = head.map((_, column) => Math.max(...table.map(cells => cells[column].length)));
  for (const cells of table) lines.push(cells.map((cell, column) => column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join("  "));
  const notes = report.rows.filter(row => row.note).map(row => `${row.source}: ${row.note}`);
  if (notes.length || report.notes.length) lines.push("", "Notes:", ...[...notes, ...report.notes].map(note => `- ${note}`));
  if (report.ignored.length) lines.push("", "Not imported (not runtime state):", ...report.ignored.map(entry => `- ${entry}`));
  lines.push("", report.mode === "apply" ? "Done. Re-running is safe: rows Convex already holds are skipped." : "Dry run: nothing was written to Convex or to the data directory. Re-run with --apply to import.");
  return lines.join("\n");
}

async function main(argv: string[]) {
  const args = argv.slice(2);
  const flag = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; args.splice(index, 2); return value; };
  const site = flag("--convex-site-url") ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  const legacyWorkspaceId = flag("--legacy-workspace-id");
  const apply = args.includes("--apply"), offline = args.includes("--offline");
  if (apply && (args.includes("--dry-run") || offline)) throw new MigrationError("--apply cannot be combined with --dry-run or --offline");
  const dir = args.find(arg => !arg.startsWith("--"));
  if (!dir || args.includes("--help")) {
    console.log("Usage: node scripts/migrate-local-store-to-convex.ts <data-dir> [--dry-run | --apply] [--offline] [--convex-site-url URL] [--legacy-workspace-id TEAM_ID]\nEnv: ORIGIN_INTEGRATION_SECRET (required to compare or apply), NEXT_PUBLIC_CONVEX_SITE_URL");
    return;
  }
  const secret = process.env.ORIGIN_INTEGRATION_SECRET;
  const transport = !offline && site && secret ? signedTransport(site, secret) : undefined;
  if (apply && !transport) throw new MigrationError("--apply needs ORIGIN_INTEGRATION_SECRET and --convex-site-url (or NEXT_PUBLIC_CONVEX_SITE_URL)");
  if (transport) console.log(`Convex: ${new URL(site!).origin}`);
  console.log(formatReport(await migrate(path.resolve(dir), { apply, transport, legacyWorkspaceId, log: line => console.log(line) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv).catch(error => { console.error(error instanceof MigrationError ? `Error: ${error.message}` : error); process.exitCode = 1; });
}
