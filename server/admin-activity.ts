// The admin activity log: who changed what on this server — settings,
// people, sessions, webhooks, MCP servers, engines, bots, budgets and bot
// visibility — written beside the decision log and kept as long.
//
// One file per UTC month under <data>/admin-activity/YYYY-MM.ndjson, 0600,
// pruned by the decision log's retention window (decision-log.ts
// `decisions.retentionDays` / OMB_DECISION_RETENTION_DAYS), so one setting
// keeps both. Each row names who acted (a signed-in session, the owner on
// this machine, a local service, or the command line), what changed (the
// setting paths), and the values before and after — redacted: a value under
// a key that names a credential, and every value in a headers or environment
// map, is written as "[hidden]", and every other string goes through the
// same content redaction the decision log uses. Nothing here is sent
// anywhere; the organisation's cloud Admin keeps its own log.
//
// Fire-and-forget, like the decision log: a full disk must not undo a
// setting that already took effect.
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { actorLabel, boundRetentionDays, pruneMonthFiles, type DecisionActor, type DecisionRow } from "./decision-log.ts";
import { redactSecrets } from "./redact.ts";
import { csvCell } from "./usage-ledger.ts";

export const ADMIN_ACTIVITY_CATEGORIES = ["config", "people", "session", "webhook", "mcp", "engine", "bot", "budget", "visibility"] as const;
export type AdminActivityCategory = typeof ADMIN_ACTIVITY_CATEGORIES[number];

/** Who acted: as on a decision row, plus the command line. */
export type AdminActor = DecisionActor | { kind: "cli" };

export interface AdminActionRow {
  at: string;
  category: AdminActivityCategory;
  /** `<thing>.<verb>`: config.update, people.update, bot.create, bot.update,
   * bot.delete, visibility.update, webhook.create, session.revoke, … */
  action: string;
  target?: { kind: string; id?: string; name?: string };
  /** The setting paths or fields that changed. Never their secret values. */
  changed?: string[];
  /** Redacted values of the changed paths, keyed by path. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  actor: AdminActor;
}

const DIR = "admin-activity";
const MONTH_FILE = /^(\d{4})-(\d{2})\.ndjson$/;
const PRUNE_EVERY_MS = 60 * 60_000;
const writeQueues = new Map<string, Promise<void>>();
const lastPrune = new Map<string, number>();

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function adminActivityFileFor(dataDir: string, at: Date): string {
  return join(dataDir, DIR, `${monthKey(at)}.ndjson`);
}

async function writeRow(dataDir: string, row: AdminActionRow): Promise<void> {
  const at = new Date(row.at);
  await mkdir(join(dataDir, DIR), { recursive: true, mode: 0o700 });
  await appendFile(adminActivityFileFor(dataDir, at), JSON.stringify(row) + "\n", { mode: 0o600 });
  if (at.getTime() - (lastPrune.get(dataDir) ?? 0) >= PRUNE_EVERY_MS) {
    lastPrune.set(dataDir, at.getTime());
    await pruneMonthFiles(join(dataDir, DIR), boundRetentionDays(), at);
  }
}

/** Append one row. Its values are redacted here, at the moment of writing. */
export function appendAdminAction(dataDir: string, row: Omit<AdminActionRow, "at"> & { at?: string }): void {
  const record: AdminActionRow = {
    ...row,
    at: row.at ?? new Date().toISOString(),
    ...(row.before ? { before: auditValues(row.before) } : {}),
    ...(row.after ? { after: auditValues(row.after) } : {}),
  };
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  const queued = previous.then(() => writeRow(dataDir, record)).catch(() => {
    /* an audit log must never take down the change it records */
  });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

/** Delete the months the retention window no longer covers. Never throws.
 * Writing prunes too; the server also runs this on a timer for quiet days. */
export function pruneAdminActivity(dataDir: string, days = boundRetentionDays(), now = new Date()): Promise<string[]> {
  return pruneMonthFiles(join(dataDir, DIR), days, now);
}

/** Test/shutdown seam: wait for every queued row to reach disk. */
export async function flushAdminActivity(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}

// ── redaction ───────────────────────────────────────────────────────────

/** Name parts that mark a credential (case-insensitive substring), as in
 * redact.ts, plus `key` standing alone or as a suffix (apiKey, xai_key). */
const SECRET_PARTS = ["token", "secret", "password", "passwd", "passphrase", "credential", "authorization", "cookie", "bearer", "apikey", "api_key"];
/** Maps whose every value may be a credential: keep the names, hide values. */
const OPAQUE_MAP = /^(?:headers|env|environment)$/i;
const MAX_VALUE_CHARS = 2_000;
const HIDDEN = "[hidden]";

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  // Counts, not credentials: maxTokens, contextTokens.
  if (lower.endsWith("tokens")) return false;
  if (SECRET_PARTS.some((part) => lower.includes(part))) return true;
  return /(?:^|[_.-])keys?$/.test(lower) || /[a-z]Keys?$/.test(name);
}

/** A command-line flag or URL parameter that names a credential:
 * `--api-key`, `--token=…`, `?key=`, `&access_token=`, `?sig=`. */
function isSecretParameter(name: string): boolean {
  // `-k` is the usual short form of --key (curl-style CLIs and many MCP servers).
  if (name === "-k" || name === "-K") return true;
  const bare = name.replace(/^-+/, "");
  return isSecretName(bare) || /^(?:auth|sig|signature|pass|pwd|code)$/i.test(bare);
}

/** A path segment that looks like a key rather than a name: it holds a run
 * of 16 or more letters and digits, mixed (Zapier-style `/s/<key>/sse`, a
 * Slack hook's last part) — a readable slug like `getting-started-2024` or a
 * UUID does not. */
function keyLikeSegment(segment: string): boolean {
  return (segment.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));
}

/** In a URL: credentials before the host (`user:pass@`, or a bare token
 * `TOKEN@`), key-like path segments, and query or fragment values whose
 * names mark a credential. */
function maskUrlSecrets(text: string): string {
  return text.replace(/\b([a-z][\w+.-]*:\/\/)([^\s/?#]*)([^\s?#]*)([^\s]*)/gi, (_all, scheme: string, authority: string, path: string, rest: string) => {
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? `${HIDDEN}@${authority.slice(at + 1)}` : authority;
    const maskedPath = path.split("/").map((segment) => (keyLikeSegment(segment) ? HIDDEN : segment)).join("/");
    const maskedRest = rest.replace(/([?&;#])([^=&#\s]+)=([^&#\s]+)/g, (all, separator: string, name: string) => (isSecretParameter(name) ? `${separator}${name}=${HIDDEN}` : all));
    return `${scheme}${host}${maskedPath}${maskedRest}`;
  });
}

/** An argument list: the value after a credential flag, or after its `=`. */
function maskArgs(items: readonly unknown[]): unknown[] {
  return items.map((item, index) => {
    const previous = items[index - 1];
    if (typeof item !== "string") return item;
    if (typeof previous === "string" && /^--?[\w-]+$/.test(previous) && isSecretParameter(previous)) return HIDDEN;
    const inline = /^(--?[\w-]+)=(.+)$/.exec(item);
    return inline && isSecretParameter(inline[1]!) ? `${inline[1]}=${HIDDEN}` : item;
  });
}

function scrub(value: unknown, depth: number, hideAll: boolean): unknown {
  if (value === undefined || value === null || value === "") return value;
  if (hideAll && typeof value !== "object") return HIDDEN;
  if (typeof value === "string") return redactSecrets(maskUrlSecrets(value));
  if (typeof value !== "object") return value;
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return maskArgs(value.slice(0, 100)).map((item) => scrub(item, depth + 1, hideAll));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretName(key) && child !== undefined && child !== null && child !== "") out[key] = HIDDEN;
    else out[key] = scrub(child, depth + 1, hideAll || OPAQUE_MAP.test(key));
  }
  return out;
}

/** A path's last segment decides, too: `anthropic.key` is a key. A value
 * too large to be useful in an audit row is summarised, not stored. */
export function auditValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    const segments = path.split(".");
    const last = segments.at(-1) ?? path;
    const opaque = segments.slice(0, -1).some((segment) => OPAQUE_MAP.test(segment));
    const scrubbed = (isSecretName(last) || opaque) && value !== undefined && value !== null && value !== ""
      ? HIDDEN
      : scrub(value, 0, OPAQUE_MAP.test(last));
    const text = JSON.stringify(scrubbed);
    out[path] = text !== undefined && text.length > MAX_VALUE_CHARS ? "[large value]" : scrubbed ?? null;
  }
  return out;
}

// ── diffs ───────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Key-order-insensitive JSON, for comparing two readings of one setting. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Dot paths (up to `depth` segments) whose values differ. A section that
 * appears or disappears is followed into, so a new key reads as the key. */
export function changedPaths(before: unknown, after: unknown, depth = 3, prefix = ""): string[] {
  if (stable(before) === stable(after)) return [];
  if (before === undefined && isPlainObject(after)) before = {};
  if (after === undefined && isPlainObject(before)) after = {};
  if (depth > 0 && isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => changedPaths(before[key], after[key], depth - 1, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix || "(all)"];
}

export function valueAt(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const segment of path.split(".")) {
    if (!isPlainObject(value)) return undefined;
    value = value[segment];
  }
  return value;
}

const pick = (source: unknown, paths: readonly string[]) =>
  Object.fromEntries(paths.map((path) => [path, valueAt(source, path) ?? null]));

/** Which log category a top-level config.json key belongs to. */
const CONFIG_CATEGORY: Record<string, AdminActivityCategory> = {
  signIn: "people",
  budgets: "budget",
  billing: "budget",
  mcpServers: "mcp",
  instances: "engine",
  anthropic: "engine",
  openaiCompat: "engine",
  xai: "engine",
  opencodeGo: "engine",
  defaultModelSelection: "engine",
};

/** The rows one change to config.json makes: one per category it touched,
 * each naming the paths that changed and their redacted values. */
export function configChangeRows(before: unknown, after: unknown): Array<Omit<AdminActionRow, "at" | "actor">> {
  const paths = changedPaths(isPlainObject(before) ? before : {}, isPlainObject(after) ? after : {});
  const byCategory = new Map<AdminActivityCategory, string[]>();
  for (const path of paths) {
    const category = CONFIG_CATEGORY[path.split(".")[0]!] ?? "config";
    byCategory.set(category, [...(byCategory.get(category) ?? []), path]);
  }
  return [...byCategory].map(([category, changed]) => ({
    category,
    action: `${category}.update`,
    target: { kind: "settings" },
    changed,
    before: pick(before, changed),
    after: pick(after, changed),
  }));
}

/** The fields of a bot an audit follows: what it may do, where, and who may
 * see it. Display fields (colour, unread, pins) are not audited. */
export const BOT_AUDIT_FIELDS = [
  "approvalMode", "autoApprove", "alwaysAllow", "peers", "approvePeerComms", "computer", "cloudBackend", "autoStartVps",
  "cwd", "composio", "browser", "browserProfile", "mcpServers", "chiefOfStaff", "managedSections", "section",
  "parkDirectMessages", "hidden", "modelSelection", "visibility",
] as const;

export function botAuditSnapshot(bot: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!bot) return null;
  // "everyone" and no field are one audience.
  const present = (field: string) => bot[field] !== undefined && !(field === "visibility" && bot[field] === "everyone");
  return Object.fromEntries(BOT_AUDIT_FIELDS.filter(present).map((field) => [field, structuredClone(bot[field])]));
}

/** A bot's audited fields that changed: a `visibility.update` row when its
 * audience changed, a `bot.update` row for everything else. `only` limits
 * the comparison to the fields a request named. */
export function botChangeRows(
  target: { id: string; name?: string },
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  only?: readonly string[],
): Array<Omit<AdminActionRow, "at" | "actor">> {
  if (!before || !after) return [];
  const changed = BOT_AUDIT_FIELDS.filter((field) => (!only || only.includes(field)) && stable(before[field]) !== stable(after[field]));
  const rows: Array<Omit<AdminActionRow, "at" | "actor">> = [];
  const bot = { kind: "bot", id: target.id, ...(target.name ? { name: target.name } : {}) };
  if (changed.includes("visibility")) {
    // An absent audience is the default: everyone.
    const audience = (value: unknown) => value ?? "everyone";
    rows.push({
      category: "visibility", action: "visibility.update", target: bot, changed: ["visibility"],
      before: { visibility: audience(before.visibility) }, after: { visibility: audience(after.visibility) },
    });
  }
  const rest = changed.filter((field) => field !== "visibility");
  if (rest.length) rows.push({ category: "bot", action: "bot.update", target: bot, changed: rest, before: pick(before, rest), after: pick(after, rest) });
  return rows;
}

// ── when to record ──────────────────────────────────────────────────────

export interface SignInLists {
  admins: readonly string[];
  members: readonly string[];
}

/** An email sign-in list that lets more than one person in: any member, a
 * second admin, or a whole @domain. */
export function sharedSignIn(lists: SignInLists): boolean {
  return lists.members.length > 0 || lists.admins.length > 1 || [...lists.admins, ...lists.members].some((entry) => entry.trim().startsWith("@"));
}

/** The sign-in lists in a config.json reading. */
export function signInListsOf(config: unknown): SignInLists {
  const signIn = isPlainObject(config) && isPlainObject(config.signIn) ? config.signIn : {};
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  return { admins: list(signIn.admins), members: list(signIn.members) };
}

// ── reading ─────────────────────────────────────────────────────────────

const isRow = (value: unknown): value is AdminActionRow =>
  isPlainObject(value) &&
  typeof value.at === "string" &&
  typeof value.category === "string" &&
  typeof value.action === "string" &&
  isPlainObject(value.actor);

function readRows(path: string): AdminActionRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: AdminActionRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRow(value)) rows.push(value);
    } catch {
      /* a line torn mid-write */
    }
  }
  return rows;
}

/** Every row inside the range, oldest first. */
export function readAdminActivityRange(dataDir: string, range: { from: Date; to: Date }): AdminActionRow[] {
  let months: string[] = [];
  try {
    months = readdirSync(join(dataDir, DIR)).filter((name) => MONTH_FILE.test(name)).sort();
  } catch {
    return [];
  }
  const first = monthKey(range.from);
  const last = monthKey(range.to);
  const from = range.from.getTime();
  const to = range.to.getTime();
  const rows: AdminActionRow[] = [];
  for (const name of months) {
    const month = basename(name, ".ndjson");
    if (month < first || month > last) continue;
    for (const row of readRows(join(dataDir, DIR, name))) {
      const at = Date.parse(row.at);
      if (at >= from && at <= to) rows.push(row);
    }
  }
  return rows;
}

// ── the Activity view: admin actions and approvals together ─────────────

export function adminActorLabel(actor: AdminActor | undefined): string {
  if (actor?.kind === "cli") return "Command line";
  return actorLabel(actor as DecisionActor | undefined);
}

/** `all`: admin actions and every card a person answered. `approvals`: the
 * answers alone. `decisions`: every decision row, automatic ones included.
 * A category: that kind of admin action. */
export type ActivityWhat = "all" | "approvals" | "decisions" | AdminActivityCategory;

export function parseActivityWhat(value: string | null): ActivityWhat | null {
  if (!value) return "all";
  if (value === "all" || value === "approvals" || value === "decisions") return value;
  return (ADMIN_ACTIVITY_CATEGORIES as readonly string[]).includes(value) ? (value as AdminActivityCategory) : null;
}

export type ActivityEntry =
  | {
      type: "approval";
      at: string;
      who: string;
      what: DecisionRow["decision"];
      source: DecisionRow["source"];
      bot?: string;
      tool?: string;
      summary?: string;
      threadId: string;
      requestId?: string;
    }
  | {
      type: "admin";
      at: string;
      who: string;
      what: AdminActivityCategory;
      action: string;
      target?: AdminActionRow["target"];
      changed?: string[];
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };

/** Both logs as one list, newest first, narrowed by who (a case-insensitive
 * part of the name, email or label shown) and what. */
export function activityEntries(
  decisions: readonly DecisionRow[],
  actions: readonly AdminActionRow[],
  filter: { what: ActivityWhat; who?: string },
): ActivityEntry[] {
  const who = filter.who?.trim().toLowerCase() ?? "";
  const entries: ActivityEntry[] = [];
  const wantDecision = (row: DecisionRow) =>
    filter.what === "decisions" || ((filter.what === "all" || filter.what === "approvals") && row.source === "user");
  for (const row of decisions) {
    if (!wantDecision(row)) continue;
    const clean = redactSecrets(row) as DecisionRow;
    entries.push({
      type: "approval",
      at: clean.at,
      who: clean.actor ? actorLabel(clean.actor) : "",
      what: clean.decision,
      source: clean.source,
      ...(clean.botName || clean.botId ? { bot: clean.botName || clean.botId } : {}),
      ...(clean.tool ? { tool: clean.tool } : {}),
      ...(clean.summary ? { summary: clean.summary } : {}),
      threadId: clean.threadId,
      ...(clean.requestId ? { requestId: clean.requestId } : {}),
    });
  }
  if (filter.what !== "approvals" && filter.what !== "decisions") {
    for (const row of actions) {
      if (filter.what !== "all" && row.category !== filter.what) continue;
      entries.push({
        type: "admin",
        at: row.at,
        who: adminActorLabel(row.actor),
        what: row.category,
        action: row.action,
        ...(row.target ? { target: row.target } : {}),
        ...(row.changed ? { changed: row.changed } : {}),
        ...(row.before ? { before: row.before } : {}),
        ...(row.after ? { after: row.after } : {}),
      });
    }
  }
  const matched = who ? entries.filter((entry) => entry.who.toLowerCase().includes(who)) : entries;
  return matched.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** One line per entry. Cells go through the usage CSV's formula
 * neutralising; values were redacted when the rows were written. */
export function activityCsv(entries: readonly ActivityEntry[]): string {
  const header = ["time", "type", "who", "what", "action", "target", "changed", "before", "after", "bot", "tool", "summary", "thread"];
  const lines = [header.join(",")];
  for (const entry of entries) {
    const cells = entry.type === "approval"
      ? [entry.at, "approval", entry.who, entry.what, entry.source, "", "", "", "", entry.bot ?? "", entry.tool ?? "", entry.summary ?? "", entry.threadId]
      : [
          entry.at, "admin", entry.who, entry.what, entry.action,
          entry.target ? entry.target.name ?? entry.target.id ?? entry.target.kind : "",
          (entry.changed ?? []).join(" "),
          entry.before ? JSON.stringify(entry.before) : "",
          entry.after ? JSON.stringify(entry.after) : "",
          "", "", "", "",
        ];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
