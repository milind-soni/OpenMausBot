// Self-modification with crash-safe rollback (the "self-modify" subsystem).
//
// A bot (or a person) proposes an edit to this server's own TypeScript as a
// JSON file dropped into DATA_DIR/self-modify/pending/. The running server
// alone validates and applies: source-backed files only, protected paths and
// content refused, every apply snapshots the exact original bytes into the
// journal before the first write, and a proposal that touches server files
// must pass a preflight syntax/build gate — any failure reverts immediately.
//
// Crash safety is layered so no single failure loses the user's working
// server: the journal records every applied-but-unverified proposal, a
// detached watchdog (electron/self-modify-watchdog.mjs) reverts this process
// if it dies before verifying itself, and boot reconciliation
// (verifyBootedProposal/failStartupCheck) covers a watchdog that died too.
// The whole subsystem is opt-in (OMB_SELF_MODIFY or feature config) and the
// safety machinery is on the protected list — the system can propose, it
// cannot touch its own leash.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";

export const SELF_MODIFY_DIR = join(DATA_DIR, "self-modify");
const PENDING_DIR = join(SELF_MODIFY_DIR, "pending");
const JOURNAL_DIR = join(SELF_MODIFY_DIR, "journal");

const MAX_PENDING_FILES = 20;
const MAX_FILES_PER_PROPOSAL = 8;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 120_000;

/** Directories whose sources back the running harness process — the only
 * files a proposal may touch. Everything else (docs, electron, scripts,
 * iOS, third_party, node_modules, the user's home…) is out of scope by
 * construction, not by pattern matching. */
const SOURCE_ROOTS = ["server", "shared", "src"] as const;

/** The machinery that makes self-modification safe must never be edited by
 * it. A proposal that adds, deletes, or modifies these is refused outright —
 * a comment-only touch counts, because a "harmless" edit to the leash is
 * exactly what an unsafe change would start with. */
const PROTECTED_EXACT = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "server/self-modify.ts",
  "server/self-modify.test.ts",
  "server/self-modify.e2e.test.ts",
  "electron/self-modify-watchdog.mjs",
]);

const PROTECTED_PREFIXES = ["server/self-modify", "electron/self-modify", ".github", "enterprise/server/self-modify"];

/** Content that must not appear in any applied file, even outside the
 * protected paths — these lines are how the other guards get disabled. */
const PROTECTED_CONTENT: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /OMB_SELF_MODIFY/, why: "toggles the self-modify gate itself" },
  { pattern: /selfModifyConfig|selfModifyEnabled|SELF_MODIFY_DIR|PENDING_DIR|JOURNAL_DIR/, why: "touches self-modify internals" },
  { pattern: /verifyBootedProposal|failStartupCheck|beginBootingProposal|revertProposal|preflightCheck/, why: "touches the revert/verify machinery" },
  { pattern: /self-modify-watchdog/, why: "touches the watchdog" },
];

export interface ProposedFile {
  path: string;
  action: "edit" | "create" | "delete";
  /** Full new file content for edit/create. A uniform-diff patch would be
   * friendlier to review but invites partial applies; whole files make the
   * journal's snapshot-and-restore trivial and exact. */
  content?: string;
}

export interface SelfModifyProposal {
  id: string;
  proposedBy: string;
  reason: string;
  files: ProposedFile[];
  /** Optional dependency change, applied via `npm install --ignore-scripts`
   * before the preflight gate. Locked-file updates are deliberately not
   * automated: the preflight build is the gate that catches a wrong tree. */
  packageJson?: Record<string, unknown>;
  testCommand?: string;
}

export type JournalStatus = "applied" | "verified" | "reverted" | "failed";

export interface JournalEntry {
  proposal: SelfModifyProposal;
  status: JournalStatus;
  appliedAt: string;
  verifiedAt?: string;
  revertedAt?: string;
  revertReason?: string;
  /** Per-file originals, restored by boot reconciliation and the watchdog. */
  entries: Array<{ path: string; backupPath?: string; deleted: boolean }>;
  /** What the preflight gate ran and what it said. */
  checks?: Array<{ name: string; ok: boolean; detail: string }>;
  /** Present while a runtime-applied proposal awaits its boot proof; the
   * pid lets boot reconciliation distinguish this boot's own proposal from
   * an abandoned one. Cleared by promotion to verified/reverted. */
  bootMarker?: { pid: number };
}

// ── project root ────────────────────────────────────────────────────────
/** The directory whose package.json backs this process. Resolved from the
 * compiled/imported location of this module, not the cwd — the server may
 * be started from anywhere. */
export function projectRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(".");
}

/** Resolve a proposal path inside the allowed source roots. Returns the
 * error string instead of throwing — refusal reasons belong in the API
 * response, not in a stack trace. */
export function resolveProposalPath(raw: string, root = projectRoot()): { path: string; absolute: string } | { error: string } {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || isAbsolute(raw)) return { error: "paths must be relative to the project root" };
  if (normalized.includes("..")) return { error: "path traversal is refused" };
  const top = normalized.split("/")[0]!;
  if (!(SOURCE_ROOTS as readonly string[]).includes(top)) {
    return { error: `only ${SOURCE_ROOTS.join("/")} sources are editable (got "${top}")` };
  }
  if (!/\.(ts|tsx|mts|cts|css|json)$/.test(normalized)) return { error: "only .ts/.tsx/.mts/.cts/.css/.json files are editable" };
  if (normalized.endsWith("package.json")) return { error: "package.json is only editable through the packageJson field" };
  const absolute = resolve(root, normalized);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "path escapes the project root" };
  return { path: normalized, absolute };
}

export function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (PROTECTED_EXACT.has(normalized)) return true;
  return PROTECTED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
export function protectedContentHit(content: string): string | null {
  for (const { pattern, why } of PROTECTED_CONTENT) {
    if (pattern.test(content)) return why;
  }
  return null;
}

// ── validation ──────────────────────────────────────────────────────────
const PROPOSAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function parseProposal(raw: string): SelfModifyProposal | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_PROPOSAL_BYTES) return { error: "proposal exceeds the 2MB cap" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "proposal is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "proposal must be an object" };
  const p = parsed as Record<string, unknown>;
  const id = typeof p.id === "string" && PROPOSAL_ID.test(p.id) ? p.id : null;
  if (!id) return { error: "id must be a short slug ([a-zA-Z0-9._-], max 64 chars)" };
  if (typeof p.proposedBy !== "string" || !p.proposedBy.trim()) return { error: "proposedBy is required" };
  if (typeof p.reason !== "string" || !p.reason.trim()) return { error: "reason is required" };
  if (!Array.isArray(p.files) || p.files.length === 0) return { error: "files must be a non-empty array" };
  if (p.files.length > MAX_FILES_PER_PROPOSAL) return { error: `at most ${MAX_FILES_PER_PROPOSAL} files per proposal` };
  const files: ProposedFile[] = [];
  const seen = new Set<string>();
  for (const item of p.files) {
    if (typeof item !== "object" || item === null) return { error: "each file must be an object" };
    const f = item as Record<string, unknown>;
    if (typeof f.path !== "string") return { error: "file.path is required" };
    if (seen.has(f.path)) return { error: `duplicate file entry: ${f.path}` };
    seen.add(f.path);
    const action = f.action === "edit" || f.action === "create" || f.action === "delete" ? f.action : null;
    if (!action) return { error: `file.action must be edit|create|delete (${f.path})` };
    if (action !== "delete" && (typeof f.content !== "string" || !f.content)) return { error: `file.content is required for ${action} (${f.path})` };
    if (typeof f.content === "string" && Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES) {
      return { error: `${f.path} exceeds the 512KB per-file cap` };
    }
    files.push({ path: f.path, action, ...(typeof f.content === "string" ? { content: f.content } : {}) });
  }
  const out: SelfModifyProposal = { id, proposedBy: p.proposedBy.trim().slice(0, 120), reason: p.reason.trim().slice(0, 2000), files };
  if (p.packageJson !== undefined) {
    if (typeof p.packageJson !== "object" || p.packageJson === null) return { error: "packageJson must be an object" };
    out.packageJson = p.packageJson as Record<string, unknown>;
  }
  if (p.testCommand !== undefined) {
    if (typeof p.testCommand !== "string" || p.testCommand.length > 300) return { error: "testCommand must be a short string" };
    out.testCommand = p.testCommand;
  }
  return out;
}

/** Full validation: schema + per-file path/protected/content checks. */
export function validateProposal(proposal: SelfModifyProposal, root = projectRoot()): string[] {
  const errors: string[] = [];
  const livePkg = join(root, "package.json");
  if (proposal.packageJson && !existsSync(livePkg)) errors.push("packageJson provided but no live package.json found");
  for (const file of proposal.files) {
    const resolved = resolveProposalPath(file.path, root);
    if ("error" in resolved) {
      errors.push(`${file.path}: ${resolved.error}`);
      continue;
    }
    if (isProtectedPath(resolved.path)) {
      errors.push(`${resolved.path}: protected path — the self-modify machinery cannot be edited by itself`);
      continue;
    }
    if (file.action === "create" && existsSync(resolved.absolute)) {
      errors.push(`${resolved.path}: create refused, file already exists (use edit)`);
    }
    if (file.action === "edit" && !existsSync(resolved.absolute)) {
      errors.push(`${resolved.path}: edit refused, file does not exist (use create)`);
    }
    if (file.action === "delete" && !existsSync(resolved.absolute)) {
      errors.push(`${resolved.path}: delete refused, file does not exist`);
    }
    if (file.action !== "delete" && file.content) {
      const why = protectedContentHit(file.content);
      if (why) errors.push(`${resolved.path}: refused content — ${why}`);
    }
  }
  if (proposal.packageJson) {
    const why = protectedContentHit(JSON.stringify(proposal.packageJson));
    if (why) errors.push(`packageJson: refused content — ${why}`);
    // Only dependency sections are merged; a proposal that smuggles scripts
    // or other lifecycle config is refused.
    const allowed = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"]);
    for (const key of Object.keys(proposal.packageJson)) {
      if (!allowed.has(key)) errors.push(`packageJson.${key}: only dependency sections may be changed`);
    }
  }
  return errors;
}

// ── journal ─────────────────────────────────────────────────────────────
const journalPath = (id: string) => join(JOURNAL_DIR, `${id}.json`);
const backupPath = (id: string, path: string) => join(JOURNAL_DIR, `${id}.backup`, path.replace(/[/\\]/g, "__"));

/** Journal writes go through here so the format stays in one place.
 * Exported for the server's operator endpoints (revert/verify/disable). */
export function writeJournal(entry: JournalEntry): void {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(journalPath(entry.proposal.id), JSON.stringify(entry, null, 2), { mode: 0o600 });
}

export function readJournal(id: string): JournalEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(journalPath(id), "utf8")) as JournalEntry;
    return parsed?.proposal?.id === id ? parsed : null;
  } catch {
    return null;
  }
}

export function listJournal(): JournalEntry[] {
  if (!existsSync(JOURNAL_DIR)) return [];
  const out: JournalEntry[] = [];
  for (const name of readdirSync(JOURNAL_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(JOURNAL_DIR, name), "utf8")) as JournalEntry);
    } catch {
      // a torn journal write is skipped, never fatal
    }
  }
  return out.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

// ── preflight gate ──────────────────────────────────────────────────────
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Parse-only probe for changed TS files: strip types, then parse as an ES
 * module without executing anything. This replaces `node --check`, which on
 * Node 22 silently passes broken files whose syntax looks like ESM (module
 * detection reads the source, and the syntax check is skipped) — a gate hole
 * discovered by the gate's own tests. Stripping with `mode: "strip"` also
 * mirrors the harness runtime: non-erasable syntax that would crash the
 * trial boot is rejected here, before anything depends on it. */
const TS_PARSE_PROBE = `// parse-only probe (see server/self-modify.ts)
const fs = require("node:fs");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
try {
  const stripped = stripTypeScriptTypes(fs.readFileSync(process.argv[1], "utf8"), { mode: "strip" });
  new vm.SourceTextModule(stripped);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;

function npmCommand(): { command: string; args: string[] } {
  // `node install` is not npm: locate npm-cli.js beside the running Node
  // (Windows layout node_modules/npm/bin, POSIX lib/node_modules). Falling
  // back to `npm` on PATH keeps this working where layouts differ.
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((candidate) => existsSync(candidate));
  return cli
    ? { command: process.execPath, args: [cli, "install", "--ignore-scripts", "--no-audit", "--no-fund"] }
    : { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] };
}

/** Syntax-check every changed server/shared .ts file without executing it,
 * so a parse error reverts before the process ever depends on the change. */
export function preflightCheck(proposal: SelfModifyProposal, root = projectRoot()): CheckResult[] {
  const checks: CheckResult[] = [];
  const tsFiles = proposal.files.filter((f) => f.action !== "delete" && /\.(ts|mts|cts)$/.test(f.path) && !f.path.startsWith("src/"));
  if (proposal.packageJson) {
    const npm = npmCommand();
    const result = spawnSync(npm.command, npm.args, {
      cwd: root,
      encoding: "utf8",
      timeout: PREFLIGHT_TIMEOUT_MS,
      shell: false,
    });
    checks.push({
      name: "npm install --ignore-scripts",
      ok: result.status === 0,
      detail: result.status === 0 ? "dependency tree updated" : `exit ${result.status}: ${(result.stderr || result.stdout || "").slice(-400)}`,
    });
    if (checks[0] && !checks[0].ok) return checks;
  }
  for (const file of tsFiles) {
    const resolved = resolveProposalPath(file.path, root);
    if ("error" in resolved) {
      checks.push({ name: `parse ${file.path}`, ok: false, detail: resolved.error });
      continue;
    }
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "-e", TS_PARSE_PROBE, resolved.absolute], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      shell: false,
    });
    checks.push({
      name: `parse ${file.path}`,
      ok: result.status === 0,
      detail: result.status === 0 ? "parses" : (result.stderr || result.stdout || "").slice(-400),
    });
  }
  return checks;
}

// ── revert ──────────────────────────────────────────────────────────────
/** Restore every file a journal entry touched, from its byte-exact backups.
 * Idempotent: re-running a completed revert is a no-op. This is the one
 * function both the watchdog and boot reconciliation rely on. */
export function revertProposal(entry: JournalEntry, reason: string, root = projectRoot()): JournalEntry {
  if (entry.status === "reverted") return entry;
  for (const item of entry.entries) {
    const absolute = resolve(root, item.path);
    try {
      if (item.deleted) {
        if (existsSync(absolute)) rmSync(absolute);
        continue;
      }
      if (item.backupPath && existsSync(item.backupPath)) {
        mkdirSync(dirname(absolute), { recursive: true });
        cpSync(item.backupPath, absolute);
      }
    } catch {
      // Best effort per file: a failed restore is recorded by leaving the
      // status at reverted-with-reason; boot reconciliation re-checks.
    }
  }
  return {
    ...entry,
    status: "reverted",
    revertedAt: new Date().toISOString(),
    revertReason: reason.slice(0, 500),
  };
}

function persistRevert(entry: JournalEntry, reason: string, root = projectRoot()): JournalEntry {
  const reverted = revertProposal(entry, reason, root);
  writeJournal(reverted);
  clearBootMarker(entry.proposal.id);
  return reverted;
}

/** Remove the live-proposal marker file, but only when it names the entry
 * just settled — a foreign revert must not blind the heartbeat watching a
 * different live trial. Best-effort: a leftover file only costs a no-op
 * heartbeat, never a wrong decision. */
function clearBootMarker(forId?: string): void {
  try {
    const markerPath = join(SELF_MODIFY_DIR, "boot-marker.json");
    if (forId !== undefined) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { id?: string } | null;
      if (marker?.id !== forId) return;
    }
    rmSync(markerPath, { force: true });
  } catch {
    // missing or unreadable marker: nothing to clear
  }
}

// ── apply ───────────────────────────────────────────────────────────────
export type ApplyResult = { ok: true; entry: JournalEntry } | { ok: false; error: string; errors?: string[] };

/** Validate, snapshot originals to the journal, apply, preflight — and
 * revert automatically on any gate failure. The journal entry is written
 * BEFORE the first file write, so a crash mid-apply leaves a recoverable
 * record, never a half-applied mystery. */
export function applyProposal(raw: string, root = projectRoot()): ApplyResult {
  const parsed = parseProposal(raw);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const proposal = parsed;

  if (readJournal(proposal.id)) return { ok: false, error: `proposal id "${proposal.id}" was already applied` };
  // One experiment at a time: a second server-touching proposal while one
  // sits at `applied` would make a rollback restore files the other change
  // was built on. Verify or revert the open one first.
  const touchedServerProposal = proposal.files.some((f) => f.path.startsWith("server/") || f.path.startsWith("shared/")) || Boolean(proposal.packageJson);
  if (touchedServerProposal && listJournal().some((item) => item.status === "applied")) {
    return { ok: false, error: "another applied proposal is awaiting its trial boot — verify or revert it first" };
  }

  const errors = validateProposal(proposal, root);
  if (errors.length) return { ok: false, error: "validation failed", errors };

  const entry: JournalEntry = { proposal, status: "applied", appliedAt: new Date().toISOString(), entries: [] };
  const touchedServer = touchedServerProposal;

  try {
    mkdirSync(JOURNAL_DIR, { recursive: true });

    // Snapshot originals first: the journal is the undo record.
    for (const file of proposal.files) {
      const resolved = resolveProposalPath(file.path, root);
      if ("error" in resolved) return { ok: false, error: `${file.path}: ${resolved.error}` };
      const exists = existsSync(resolved.absolute);
      if (exists) {
        const backup = backupPath(proposal.id, resolved.path);
        mkdirSync(dirname(backup), { recursive: true });
        cpSync(resolved.absolute, backup);
        entry.entries.push({ path: resolved.path, backupPath: backup, deleted: false });
      } else {
        entry.entries.push({ path: resolved.path, deleted: true });
      }
    }
    if (proposal.packageJson) {
      const backup = backupPath(proposal.id, "package.json");
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(join(root, "package.json"), backup);
      entry.entries.push({ path: "package.json", backupPath: backup, deleted: false });
    }
    writeJournal(entry);

    // Apply file writes.
    for (const file of proposal.files) {
      const resolved = resolveProposalPath(file.path, root);
      if ("error" in resolved) throw new Error(resolved.error);
      if (file.action === "delete") {
        rmSync(resolved.absolute);
        continue;
      }
      mkdirSync(dirname(resolved.absolute), { recursive: true });
      writeFileSync(resolved.absolute, file.content ?? "", "utf8");
    }

    // Merge dependency sections into the live package.json.
    if (proposal.packageJson) {
      const live = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
      for (const [section, value] of Object.entries(proposal.packageJson)) {
        live[section] = value;
      }
      writeFileSync(join(root, "package.json"), `${JSON.stringify(live, null, 2)}\n`, "utf8");
    }

    // The gate: server-touching proposals must prove they still build. A
    // failed gate reverts on the spot — the error message may not lie.
    if (touchedServer) {
      const checks = preflightCheck(proposal, root);
      entry.checks = checks;
      const failed = checks.find((check) => !check.ok);
      if (failed) {
        const reverted = persistRevert(entry, `preflight failed: ${failed.name}`, root);
        return {
          ok: false,
          error: `preflight failed: ${failed.name} — ${failed.detail}; changes reverted`,
          errors: checks.map((c) => `${c.name}: ${c.ok ? "ok" : c.detail}`).concat(`journal status: ${reverted.status}`),
        };
      }
    }

    // The edit is now in force on disk while THIS process keeps its old
    // code in memory; the NEXT boot is the trial (index.ts marks it with
    // that boot's pid and arms the watchdog). No marker here: a marker
    // belongs to the boot doing the proving. UI edits (src/) are inert
    // until a rebuild, so there is nothing to prove.
    writeJournal(entry);
    return { ok: true, entry };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reverted = persistRevert(entry, `apply error: ${message}`, root);
    return { ok: false, error: `${message}; changes reverted`, errors: [`journal status: ${reverted.status}`] };
  }
}

// ── pending inbox ───────────────────────────────────────────────────────
export function listPending(): Array<{ file: string; id: string | null; proposedBy: string | null; reason: string | null; bytes: number; invalid?: string }> {
  if (!existsSync(PENDING_DIR)) return [];
  const out: Array<{ file: string; id: string | null; proposedBy: string | null; reason: string | null; bytes: number; invalid?: string }> = [];
  const names = readdirSync(PENDING_DIR).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_PENDING_FILES);
  for (const name of names) {
    const path = join(PENDING_DIR, name);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
      const raw = readFileSync(path, "utf8");
      const parsed = parseProposal(raw);
      if ("error" in parsed) {
        out.push({ file: name, id: null, proposedBy: null, reason: null, bytes, invalid: parsed.error });
        continue;
      }
      const errors = validateProposal(parsed);
      out.push({
        file: name,
        id: parsed.id,
        proposedBy: parsed.proposedBy,
        reason: parsed.reason.slice(0, 200),
        bytes,
        ...(errors.length ? { invalid: errors.join("; ") } : {}),
      });
    } catch (error) {
      out.push({ file: name, id: null, proposedBy: null, reason: null, bytes, invalid: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

export function readProposal(id: string): { raw: string; file: string } | null {
  if (!existsSync(PENDING_DIR)) return null;
  for (const name of readdirSync(PENDING_DIR)) {
    if (!name.endsWith(".json")) continue;
    const path = join(PENDING_DIR, name);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = parseProposal(raw);
      if ("error" in parsed) continue;
      if (parsed.id === id) return { raw, file: name };
    } catch {
      continue;
    }
  }
  return null;
}

/** Apply a pending proposal file and consume it. Returns the apply result;
 * the pending file is only removed on a well-formed (ok or gate-failed)
 * outcome — malformed files stay for their author to inspect. */
export function applyPending(id: string, root = projectRoot()): ApplyResult & { consumed: boolean } {
  const found = readProposal(id);
  if (!found) return { ok: false, error: "no pending proposal with that id", consumed: false };
  const result = applyProposal(found.raw, root);
  if (result.ok || result.errors) {
    try {
      rmSync(join(PENDING_DIR, found.file));
    } catch {
      // inbox cleanup is best-effort
    }
    return { ...result, consumed: true };
  }
  return { ...result, consumed: false };
}

/** Remove a pending proposal without applying it. */
export function discardPending(id: string): boolean {
  const found = readProposal(id);
  if (!found) return false;
  try {
    rmSync(join(PENDING_DIR, found.file), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ── startup reconciliation ──────────────────────────────────────────────
// Journal entries move through: applied (runtime edit, in force) → verified
// (its process booted and served a health check) — or → reverted. Exactly
// one entry may sit at `applied` across restarts; that is the proposal this
// boot must prove or roll back.

/** The newest entry applied by a RUNNING process (boot-marker present) and
 * not yet verified — the one this boot must prove or revert. */
export function activeProposalFor(): JournalEntry | null {
  return listJournal().find((entry) => entry.status === "applied" && entry.bootMarker !== undefined) ?? null;
}

/** Runtime apply path: mark the entry as owned by THIS boot so a crash
 * before the listener comes up is distinguishable from an old, abandoned
 * edit. The marker file carries the pid and a fresh mtime the watchdog's
 * liveness check can also read. */
export function markProposalForBoot(entry: JournalEntry): JournalEntry {
  const pid = process.pid;
  writeFileSync(join(SELF_MODIFY_DIR, "boot-marker.json"), JSON.stringify({ id: entry.proposal.id, pid, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const marked: JournalEntry = { ...entry, bootMarker: { pid } };
  writeJournal(marked);
  return marked;
}

/** Called by index.ts when the listener is accepting requests: the changed
 * code just parsed, ran, and bound its port — the riskiest part of boot is
 * behind us, so the live proposal is promoted to verified. Deliberately the
 * ONLY promotion path: a later process never verifies an earlier one's
 * unverified proposal — it cannot know why that process died, so boot
 * reconciliation reverts those instead (safe by default). */
export function verifyBootedProposal(): JournalEntry | null {
  const entry = activeProposalFor();
  if (!entry) return null;
  const verified: JournalEntry = { ...entry, status: "verified", verifiedAt: new Date().toISOString() };
  writeJournal(verified);
  clearBootMarker(entry.proposal.id);
  return verified;
}

/** Called from a top-level boot failure handler: this process could not
 * finish starting with the proposal applied, so restore the originals.
 * The caller re-exits; the next boot runs the known-good code. */
export function failStartupCheck(reason: string, root = projectRoot()): JournalEntry | null {
  const entry = activeProposalFor();
  if (!entry) return null;
  return persistRevert(entry, reason, root);
}

/** Dev-loop escape hatch: end a completed experiment by marking its entry
 * verified (or reverting it) without restarting. Not part of the safety
 * story — the boot/witness paths above are. */
export function settleProposal(id: string, outcome: "verified" | "reverted", reason?: string, root = projectRoot()): JournalEntry | null {
  const entry = readJournal(id);
  if (!entry || entry.status !== "applied") return null;
  if (outcome === "verified") {
    const settled: JournalEntry = { ...entry, status: "verified", verifiedAt: new Date().toISOString() };
    writeJournal(settled);
    clearBootMarker(entry.proposal.id);
    return settled;
  }
  return persistRevert(entry, reason ?? "settled as reverted by the operator", root);
}

/** Startup sweep: anything left `applied` from a previous run whose process
 * is long gone (watchdog died too) gets reverted before serving. */
export function reconcileAbandonedProposals(root = projectRoot()): string[] {
  const reverted: string[] = [];
  for (const entry of listJournal()) {
    if (entry.status !== "applied") continue;
    // This boot's own runtime-applied proposal keeps its marker and is
    // promoted by verifyBootedProposal after the listener is up; anything
    // else at `applied` is from an older run that never verified.
    if (entry.bootMarker !== undefined && entry.bootMarker.pid === process.pid) continue;
    reverted.push(entry.proposal.id);
    persistRevert(entry, "startup reconciliation: proposal never verified by its boot", root);
  }
  return reverted;
}
