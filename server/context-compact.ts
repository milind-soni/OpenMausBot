// Session compaction: a separate summarizer call, then a brand-new native
// session whose first prompt is the state vector. The local model is not
// told it restarted — inject the bare vector (no "task state" / restart framing).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

import { DEFAULT_EXTRACTION_PROMPT } from "../shared/compact-around.ts";

/** Soft sanity cap when folding a live notebook stack into V (tens of k chars OK). */
const NOTEBOOK_FOLD_SOFT_CAP_CHARS = 48_000;
/** ~30 token floor for a folded notebook vector. */
const NOTEBOOK_FOLD_MIN_TOKENS = 30;
import { decodeInjectId, hostApiKey, localHost } from "./drivers/local-inject.ts";
import {
  clipFromTail,
  estimateTokens,
  type FacingTurn,
} from "./context-rebuild.ts";

export { DEFAULT_EXTRACTION_PROMPT };

const RESTART_LANGUAGE = /\b(restart(ed|ing)?|compacted|compaction|session\/new|you are joining|rewound this conversation|brand new session|you (never )?restarted)\b/i;


/** Soft cap for the live user turn after a refresh. Full text stays in the
 * OpenMausBot transcript; the provider only needs a short needle. */
export const COMPACT_USER_CLIP_CHARS = 1_200;

export function clipCompactUserText(text: string, maxChars = COMPACT_USER_CLIP_CHARS): string {
  const live = text.trim();
  if (!live) return "";
  if (live.length <= maxChars) return live;
  return (
    `${live.slice(0, maxChars).trimEnd()}\n` +
    "…[clipped for refreshed context; full text remains in the OpenMausBot transcript]"
  );
}

/** Giant UNIQUE/hex paste used to inflate Goal/Next — keep canaries + paths. */
export function isBulkPadText(text: string): boolean {
  const t = text.trim();
  if (t.length < 800) return false;
  if (/\bUNIQUE[-_][A-Za-z0-9_-]{6,}/i.test(t) && t.length > 2_000) return true;
  const hexRuns = t.match(/[0-9a-f]{32,}/gi) ?? [];
  const hexChars = hexRuns.join("").length;
  if (hexChars > t.length * 0.35 && t.length > 1_500) return true;
  const spaces = (t.match(/\s/g) ?? []).length;
  if (t.length > 4_000 && spaces / t.length < 0.02) return true;
  return false;
}

export function stubBulkPadText(text: string): string {
  const t = text.trim();
  if (!isBulkPadText(t)) return t;
  const head = t.slice(0, 180).replace(/\s+/g, " ").trim();
  const canaries = [...t.matchAll(/\b(CANARY[_-][A-Za-z0-9_-]+)\b/g)].map((m) => m[1]!);
  const paths = [...t.matchAll(/\/(?:tmp|Users|var|home|opt)[^\s]{2,120}/g)].map((m) => m[0]).slice(0, 4);
  const bits = [
    `[bulk paste omitted — ${t.length} chars]`,
    head ? `head: ${head}…` : "",
    canaries.length ? `canaries: ${[...new Set(canaries)].join(", ")}` : "",
    paths.length ? `paths: ${[...new Set(paths)].join(", ")}` : "",
  ].filter(Boolean);
  return bits.join("\n");
}

/** Strip UNIQUE/pad lines from vector sections so Goal/Open stay actionable. */
export function demotePadBlobsInVector(summary: string): string {
  const lines = summary.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (/^(Goal|This turn|Verified facts|Addresses|Landmines|Constraints|Open|Next action|Live user)\b/i.test(trimmed)) {
      out.push(line);
      continue;
    }
    if (isBulkPadText(trimmed) || (trimmed.length > 240 && /UNIQUE[-_]/i.test(trimmed) && /[0-9a-f]{40}/i.test(trimmed))) {
      out.push(stubBulkPadText(trimmed).split("\n")[0]!);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Mid-task continuity appended to system when compact/rewrite is active.
 * No compacted/restarted wording — models echo that and re-greet. */
export const MID_TASK_CONTINUITY_SYSTEM =
  "Mid-task: working memory is above. Answer the latest user message. Do not greet, re-acknowledge persona, or ask for a first instruction.";

/** Open/Next bodies that are stalls / soft-park / meta — replace with a forward line from the live ask. */
const NEXT_ACTION_BAN =
  /\b(?:done\.?|wait for next|provide(?:\s+a)?\s+prompt|await(?:ing)?(?:\s+the)?\s+user|await(?:ing)?(?:\s+the)?\s+next\b|confirm(?:ing)?(?:\s+\w+){0,8}\s+last turn|provide(?:\s+the)?\s+(?:first|next)\s+(?:instruction|task)|ask(?:\s+the\s+user)?\s+for(?:\s+(?:the|a))?\s+(?:first|next)\s+(?:instruction|task)|wait(?:ing)?(?:\s+for)?(?:\s+the)?\s+(?:next|user)\b|successor should await)\b/i;

const FILL_HASH_LABEL = /\bFill\s*#\d+\b/gi;

const SECTION_HEADING =
  /^(?:#{1,3}\s*)?(?:\*\*)?(Goal|This turn|Verified facts|Addresses|Landmines|Constraints|Open|Next action|Live user|Single next action|Next\b|Recommendation\b)\b/i;

/** Provider-facing live ask after compact (stub pads + soft clip). */
export function providerLiveAsk(userText: string): string {
  return clipCompactUserText(stubBulkPadText(userText));
}

/**
 * Shared compacted shape for host-proxy rewrite and Grok/openai-chat:
 * separate user turns for the state vector and the live ask (no mash).
 */
export function compactedProviderUserTurns(
  vector: string,
  userText: string,
): { vector: string; liveAsk: string } {
  return { vector: vector.trim(), liveAsk: providerLiveAsk(userText) };
}

/** One forward line derived from the live user ask (sanitizer rail). */
export function forwardNextFromLiveAsk(userText: string): string {
  const live = stubBulkPadText(userText).trim().replace(/\s+/g, " ");
  if (!live) return "Continue the current user task from the latest ask.";
  const clipped = live.length > 220 ? `${live.slice(0, 220).trimEnd()}…` : live;
  return clipped;
}

function stripFillLabelsInGoalConstraints(summary: string): string {
  const lines = summary.split("\n");
  const out: string[] = [];
  let section = "";
  for (const line of lines) {
    const trimmed = line.trim();
    const head = trimmed.match(SECTION_HEADING);
    if (head) {
      const name = (head[1] ?? "").toLowerCase();
      if (name.startsWith("goal")) section = "goal";
      else if (name.startsWith("constraint")) section = "constraints";
      else if (/^open\b|^next\b|next action|single next|recommendation/i.test(name)) section = "next";
      else section = "other";
      out.push(line);
      continue;
    }
    if ((section === "goal" || section === "constraints") && (FILL_HASH_LABEL.lastIndex = 0, FILL_HASH_LABEL.test(trimmed))) {
      FILL_HASH_LABEL.lastIndex = 0;
      const cleaned = line.replace(FILL_HASH_LABEL, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, "");
      if (cleaned.trim()) out.push(cleaned);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function replaceBannedNext(summary: string, userText: string): string {
  const next = extractNextBlock(summary);
  if (!next) return summary;
  const body = next
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();
  if (!NEXT_ACTION_BAN.test(body) && !NEXT_ACTION_BAN.test(next)) return summary;
  const forward = forwardNextFromLiveAsk(userText);
  const replacement = `Open\n${forward}`;
  const trimmed = summary.trim();
  if (trimmed.endsWith(next)) {
    const head = trimmed.slice(0, trimmed.length - next.length).trimEnd();
    return head ? `${head}\n\n${replacement}` : replacement;
  }
  return `${trimmed.replace(next, "").trimEnd()}\n\n${replacement}`.trim();
}

/** Post-LLM rail: forward-only Open/Next + strip Fill #N from Goal/Constraints.
 * Understands legacy Next action headings; banned soft-park rewrites to Open. */
export function sanitizeForwardOnlyVector(summary: string, userText: string): string {
  let out = stripFillLabelsInGoalConstraints(summary);
  out = replaceBannedNext(out, userText);
  return out.trim();
}

export function appendMidTaskContinuitySystem(systemText: string): string {
  const base = systemText.trimEnd();
  if (!base) return MID_TASK_CONTINUITY_SYSTEM;
  if (base.includes("Mid-task:") && base.includes("working memory is above")) return base;
  return `${base} ${MID_TASK_CONTINUITY_SYSTEM}`;
}

/** @deprecated Prefer compactedProviderUserTurns — kept for tests that assert mash absence of restart framing. */
export function injectStateVector(summary: string, userText: string): string {
  const { vector, liveAsk } = compactedProviderUserTurns(summary, userText);
  if (!liveAsk) return vector;
  return [vector, "", liveAsk].join("\n");
}

export function resolveOutgoingTurn(input: {
  compacted: boolean;
  summary: string;
  userText: string;
  turnText: string;
  resumeCursor: unknown;
  transcript: FacingTurn[];
}): { text: string; resumeCursor: unknown; transcript: FacingTurn[] } {
  if (!input.compacted) {
    return { text: input.turnText, resumeCursor: input.resumeCursor, transcript: input.transcript };
  }
  // Every harness must see the vector on the main user message (`text`).
  // Claude Code ignores `transcript`; openai-chat would double-count if we
  // also put the vector there — so compacted turns carry vector+ask in text
  // only. Host-proxy rewrite remains a second belt for inject drivers.
  const text = injectStateVector(input.summary, input.userText).trim() || input.userText.trim();
  return {
    text,
    resumeCursor: undefined,
    transcript: [],
  };
}

const TOOL_CHIP = /^\[tool\s.+\s→\s/;
const TOOL_CHIP_PARSE = /^\[tool\s+(.+?)\s+→\s+(ok|failed|running)\]\s*$/i;
const HEX_ADDR = /\b0x[0-9a-fA-F]{5,16}\b/g;
const SECRET_LINE = /^\s*(?:[-*]\s*)?(?:activationKey|license\s*key)\s*=/i;
const SKIP_PATH_PART = /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/i;

export function isToolChip(text: string): boolean {
  return TOOL_CHIP.test(text.trim());
}

export function proseTurns(turns: FacingTurn[]): FacingTurn[] {
  return turns.filter((turn) => !isToolChip(turn.text));
}

export function harvestAddresses(...blobs: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const blob of blobs) {
    if (!blob) continue;
    for (const match of blob.matchAll(HEX_ADDR)) {
      const addr = match[0]!;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

export type GitWorkingTree = {
  branch: string;
  dirty: string[];
};

export type WorkPointers = {
  paths: string[];
  lastFailed: string | null;
  git: GitWorkingTree | null;
};

function normalizePathToken(raw: string): string | null {
  const p = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!p || SKIP_PATH_PART.test(p)) return null;
  if (/^https?:\/\//i.test(p)) return null;
  return p;
}

function harvestFilePaths(text: string, includeBare: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const p = normalizePathToken(raw);
    if (!p) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const filePathRe =
    /(?<![A-Za-z0-9_])((?:~\/|\/|[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][\w.-]*(?::\d{1,6})?)/g;
  for (const match of text.matchAll(filePathRe)) add(match[1]!);
  if (includeBare) {
    const bareRe =
      /(?<![A-Za-z0-9_./])([\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|swift|java|kt|rb|md|json|jsonc|yml|yaml|toml|css|html|vue|svelte|sql|sh|rhai))(?::\d{1,6})?(?![A-Za-z0-9_])/gi;
    for (const match of text.matchAll(bareRe)) add(match[1]!);
  }
  return out;
}

const FAIL_HINT =
  /\b(exit\s+[1-9]\d*|no such file|command not found|FAILED\b|Error TS|AssertionError|fails? with)\b/i;

const COMMAND_CHIP =
  /^(?:auto-approved\s+[^:]+:\s*)?(?:ls|pnpm|npm|npx|yarn|bun|git|vitest|tsc|cargo|go|python3?|swift|rg|grep|cat|mkdir|rm|curl|make|pytest|jest|node|bash)\b/i;

function looksLikeCommand(title: string): boolean {
  const t = title.replace(/^auto-approved\s+[^:]+:\s*/i, "").trim();
  return COMMAND_CHIP.test(t);
}

function harvestLastFailed(turns: FacingTurn[]): string | null {
  let lastFailed: string | null = null;
  const commandChips: string[] = [];
  const assistant: string[] = [];
  for (const turn of turns) {
    const chip = turn.text.trim().match(TOOL_CHIP_PARSE);
    if (chip) {
      const title = chip[1]!.trim().slice(0, 200);
      const outcome = chip[2]!.toLowerCase();
      if (looksLikeCommand(title)) commandChips.push(title);
      if (outcome === "failed" || FAIL_HINT.test(title)) lastFailed = title;
      continue;
    }
    if (turn.role === "assistant") assistant.push(turn.text);
  }
  const blob = assistant.join("\n");
  if (FAIL_HINT.test(blob)) {
    for (let i = commandChips.length - 1; i >= 0; i--) {
      const cmd = commandChips[i]!;
      const head = cmd.split(";")[0]!.trim();
      if (head.length >= 8 && blob.includes(head)) return head;
      if (blob.includes(cmd.slice(0, 48))) return cmd;
    }
    const quoted = blob.match(
      /`([^`\n]{3,200})`\s*[:\-\u2014,]?\s*(failed|fails with|no such file|exit\s+[1-9])/i,
    );
    if (quoted?.[1]?.trim() && looksLikeCommand(quoted[1].trim())) return quoted[1].trim();
  }
  return lastFailed;
}

/** `git status` when cwd is a repo with dirty files. Fail open: not a repo, git missing, ancestor git, or clean → null. */
export function readGitWorkingTree(cwd: string | null | undefined): GitWorkingTree | null {
  const dir = existingDirectory(cwd);
  if (!dir) return null;
  try {
    // Require a .git entry in cwd itself so we never walk into an ancestor repo.
    // Comparing `git rev-parse --show-toplevel` to cwd is brittle on Windows
    // (drive-letter case, \\?\ prefixes, slash style) and caused false nulls in CI.
    if (!existsSync(join(dir, ".git"))) return null;
    const porcelain = spawnSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (porcelain.error || porcelain.status !== 0) return null;
    const branchRun = spawnSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = (branchRun.stdout ?? "").trim();
    const dirty: string[] = [];
    for (const line of (porcelain.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      const path = (line.length >= 4 ? line.slice(3) : line).trim();
      if (!path || SKIP_PATH_PART.test(path)) continue;
      if (/(^|[\s/"'])\.env(\.|$|["'\s])/i.test(path)) continue;
      if (/\.ssh\/|id_rsa|id_ed25519|credentials?\.json/i.test(path)) continue;
      dirty.push(path.slice(0, 200));
      if (dirty.length >= 20) break;
    }
    if (dirty.length === 0) return null;
    return { branch: branch || "(detached)", dirty };
  } catch {
    return null;
  }
}

/** Paths and last failure from tool titles. Git only when cwd itself is a dirty repo. */
export function harvestWorkPointers(
  turns: FacingTurn[],
  opts?: { cwd?: string | null; git?: GitWorkingTree | null },
): WorkPointers {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    const chip = turn.text.trim().match(TOOL_CHIP_PARSE);
    if (!chip) continue;
    const title = chip[1]!.trim();
    for (const path of harvestFilePaths(title, true)) {
      const key = path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
      if (paths.length >= 20) break;
    }
  }
  const lastFailed = harvestLastFailed(turns);
  const git = opts && Object.prototype.hasOwnProperty.call(opts, "git")
    ? (opts.git ?? null)
    : readGitWorkingTree(opts?.cwd ?? null);
  return { paths, lastFailed, git };
}

function insertBeforeNext(summary: string, block: string): string {
  const chunk = block.trim();
  if (!chunk) return summary;
  if (summary.includes(chunk)) return summary;
  const next = extractNextBlock(summary);
  const trimmed = summary.trim();
  if (next && trimmed.endsWith(next)) {
    const head = trimmed.slice(0, trimmed.length - next.length).trimEnd();
    return head ? `${head}\n\n${chunk}\n\n${next}` : `${chunk}\n\n${next}`;
  }
  return `${trimmed}\n\n${chunk}`;
}

/** Glue live work pointers onto the six-heading page. Empty sections stay omitted. */
export function mergeWorkPointers(summary: string, pointers: WorkPointers): string {
  let out = mergeHarvestedAddresses(summary, pointers.paths);
  const blocks: string[] = [];
  if (pointers.git && pointers.git.dirty.length > 0 && !/^Working tree\s*$/m.test(out)) {
    const lines = ["Working tree"];
    if (pointers.git.branch) lines.push(pointers.git.branch);
    lines.push(...pointers.git.dirty);
    blocks.push(lines.join("\n"));
  }
  if (pointers.lastFailed && !out.includes(pointers.lastFailed)) {
    blocks.push(`Last error\n${pointers.lastFailed}`);
  }
  if (pointers.paths.length > 0 && !/^Re-read\s*$/m.test(out)) {
    blocks.push(["Re-read", ...pointers.paths, "Do not invent the next patch."].join("\n"));
  }
  for (const block of blocks) out = insertBeforeNext(out, block);
  return out;
}

export function stripSecretLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !SECRET_LINE.test(line))
    .join("\n");
}

/** A dedicated handoff this long is already the successor page — do not smear the chat over it. */
export const HANDOFF_AS_VECTOR_MIN_CHARS = 400;

/** A disk handoff already in vector shape — use it instead of re-summarizing chat.
 * Headings must be at line start so MEMORY.md bullets like `- Goal:` do not qualify.
 * Hex VAs are optional: coding bots have paths, not 0x addresses. */
/** House MEMORY.md template with no live task facts — do not let it drown a recap. */
export function isBoilerplateMemory(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (!/Durable notes this bot keeps between tasks/i.test(t)) return false;
  if (looksLikeHandoff(t)) return false;
  const withoutHeader = t.replace(/^# Memory[\s\S]*?read on demand\.\s*/i, "").trim();
  return withoutHeader.length < 200;
}

export function looksLikeHandoff(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  const hasGoal = /^(?:#{1,3}\s*)?Goal\b/mi.test(t);
  const hasOpenOrNext =
    /^(?:#{1,3}\s*)?(?:Open\b|Next action|Single next action|Next\b|Recommendation\b)/mi.test(t);
  return hasGoal && hasOpenOrNext;
}

/** Last Open / legacy Next / Recommendation block — must survive a budget clip. */
const NEXT_HEADING =
  /^(?:#{1,3}\s*)?(?:\*\*)?(?:Open\b|Next action|Single next action|Next\b|Recommendation\b)/im;

const LIVE_USER_SKIP = /^(continue|keep going|go on|go|ok|status|\.|…)$/i;

/** Keep a specific live user turn in the recap so seed/handoff cannot drown it. */
export function mergeLiveUser(summary: string, userText: string): string {
  const live = stubBulkPadText(userText.trim());
  if (!live || (live.length < 48 && LIVE_USER_SKIP.test(live))) return summary;
  const snippet = live.slice(0, Math.min(80, live.length));
  if (summary.includes(snippet)) return summary;
  const clipped = clipCompactUserText(live);
  const block = `Live user\n${clipped}`;
  const next = extractNextBlock(summary);
  const trimmed = summary.trim();
  if (next && trimmed.endsWith(next)) {
    const head = trimmed.slice(0, trimmed.length - next.length).trimEnd();
    return head ? `${head}\n\n${block}\n\n${next}` : `${block}\n\n${next}`;
  }
  return `${trimmed}\n\n${block}`;
}

/** Last Open / legacy Next / Recommendation block — must survive a budget clip. */
export function extractNextBlock(text: string): string {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (NEXT_HEADING.test(lines[i]!.trim())) start = i;
  }
  if (start < 0) return "";
  return lines.slice(start).join("\n").trim();
}

/** Clip from the head, but keep the Next block intact at the end. */
export function clipKeepingNext(text: string, maxTokens: number): string {
  const cleaned = text
    .split("\n")
    .filter((line) => !RESTART_LANGUAGE.test(line))
    .join("\n")
    .trim();
  const budgetChars = Math.max(256, maxTokens) * 4;
  if (cleaned.length <= budgetChars) return cleaned;
  const next = extractNextBlock(cleaned);
  if (!next) {
    return `${cleaned.slice(0, Math.max(0, budgetChars - 1)).trimEnd()}…`;
  }
  const reserved = next.length + 2;
  const headBudget = Math.max(0, budgetChars - reserved);
  const withoutNext = cleaned.endsWith(next)
    ? cleaned.slice(0, cleaned.length - next.length).trimEnd()
    : cleaned.replace(next, "").trimEnd();
  const head = withoutNext.slice(0, headBudget).trimEnd();
  return head ? `${head}\n\n${next}` : next.slice(0, budgetChars);
}

export function existingDirectory(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    let p = path.trim();
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(1));
    p = normalize(p);
    if (!existsSync(p)) return null;
    if (!statSync(p).isDirectory()) return null;
    return resolve(p);
  } catch {
    return null;
  }
}

export function dirHasCompactSeed(dir: string): boolean {
  try {
    if (existsSync(join(dir, "MEMORY.md")) || existsSync(join(dir, "HANDOFF.md"))) return true;
    return readdirSync(dir).some((name) => /^handoff_.*\.md$/i.test(name));
  } catch {
    return false;
  }
}

function skipInstructionDir(dir: string): boolean {
  const resolved = resolve(dir);
  const home = resolve(homedir());
  if (resolved === "/" || resolved === home || /^[A-Za-z]:\\?$/.test(resolved)) return true;
  const unix = resolved.replace(/\\/g, "/").toLowerCase();
  return unix === "/users" || unix === "/home" || unix === "/volumes";
}

/** Absolute paths in Instructions that exist and actually hold MEMORY/handoff files.
 * Instructions is prompt text, not a folder field — only keep dirs that have seed files
 * so mentioning /Applications or $HOME does not get scanned. */
export function instructionSeedDirs(text: string | null | undefined, limit = 4): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s`'"(])(~?(?:\/[^\s`'<>"|]+)|[A-Za-z]:[\\/][^\s`'<>"|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && found.length < limit) {
    const raw = (match[1] ?? "").replace(/[.,;:!?)]+$/, "");
    const dir = existingDirectory(raw);
    if (!dir || seen.has(dir) || skipInstructionDir(dir) || !dirHasCompactSeed(dir)) continue;
    seen.add(dir);
    found.push(dir);
  }
  return found;
}

/** Folders compact should read for every bot: private MEMORY home, the pinned
 * working folder, and any real project path the user wrote in Instructions. */
export function collectCompactSeedDirs(input: {
  privateWorkspace?: string | null;
  taskCwd?: string | null;
  botCwd?: string | null;
  instructions?: string | null;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const dir = existingDirectory(raw);
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    out.push(dir);
  };
  add(input.privateWorkspace);
  add(input.taskCwd);
  add(input.botCwd);
  for (const dir of instructionSeedDirs(input.instructions)) add(dir);
  return out;
}

export type WorkspaceSeedParts = {
  combined: string;
  newestHandoff: string;
};

/** MEMORY.md plus the newest handoff_*.md across the seed folders. Never
 * reads Desktop Engineering dumps unless that folder is itself a seed dir. */
export function readWorkspaceSeedParts(
  cwd: string | Array<string | null | undefined> | null | undefined,
  maxChars = 8_000,
): WorkspaceSeedParts {
  const raw = Array.isArray(cwd) ? cwd : [cwd];
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const dir = existingDirectory(entry);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  if (dirs.length === 0) return { combined: "", newestHandoff: "" };
  const parts: string[] = [];
  let newest: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    try {
      const memory = join(dir, "MEMORY.md");
      if (existsSync(memory)) {
        const body = readFileSync(memory, "utf8");
        if (!isBoilerplateMemory(body)) parts.push(body);
      }
      for (const name of readdirSync(dir)) {
        if (!/^handoff_.*\.md$/i.test(name) && name !== "HANDOFF.md") continue;
        const path = join(dir, name);
        const mtime = statSync(path).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path, mtime };
      }
    } catch {
      /* skip unreadable dir */
    }
  }
  let newestHandoff = "";
  if (newest) {
    newestHandoff = stripSecretLines(readFileSync(newest.path, "utf8")).trim();
    parts.push(newestHandoff);
  }
  return {
    combined: stripSecretLines(parts.join("\n\n")).trim().slice(0, maxChars),
    newestHandoff,
  };
}

export function readWorkspaceSeed(
  cwd: string | Array<string | null | undefined> | null | undefined,
  maxChars = 8_000,
): string {
  return readWorkspaceSeedParts(cwd, maxChars).combined;
}

export function mergeHarvestedAddresses(summary: string, addresses: string[]): string {
  if (addresses.length === 0) return summary;
  const quotedHex = harvestAddresses(summary);
  const missing = addresses.filter((addr) => {
    if (summary.includes(addr)) return false;
    if (/^0x[0-9a-f]+$/i.test(addr)) {
      return !quotedHex.some((have) => have.toLowerCase() === addr.toLowerCase());
    }
    return true;
  });
  if (missing.length === 0) return summary;
  const block = missing.join("\n");
  if (/\nAddresses\n\(none quoted\)/.test(summary)) {
    return summary.replace(/\nAddresses\n\(none quoted\)/, `\nAddresses\n${block}`);
  }
  if (/^Addresses\s*$/m.test(summary)) {
    return summary.replace(/^Addresses\s*$/m, `Addresses\n${block}`);
  }
  return `${summary.trim()}\n\nAddresses\n${block}`;
}

function extractiveFallback(
  turns: FacingTurn[],
  previousSummary: string | undefined,
  maxTokens: number,
  seed?: string,
  microLedger?: string,
): string {
  const prose = proseTurns(turns);
  const users = prose.filter((turn) => turn.role === "user");
  const assistants = prose.filter((turn) => turn.role === "assistant");
  const firstUser = stubBulkPadText(users[0]?.text.trim() ?? "");
  const lastUser = stubBulkPadText(users.at(-1)?.text.trim() ?? "");
  const lastAssistant = assistants.at(-1)?.text.trim() ?? "";
  const notebook = microLedger?.trim() ?? "";
  const blob = [notebook || undefined, seed, previousSummary, ...prose.map((turn) => turn.text)].join("\n");
  const addrs = harvestAddresses(blob);
  // When a notebook is present, never smear MEMORY/seed canaries into Verified facts.
  const facts = notebook
    ? notebook.slice(0, 2_500)
    : seed?.trim()
      ? seed.trim().slice(0, 2_500)
      : previousSummary?.trim()
        ? previousSummary.trim().slice(0, 1_200)
        : assistants
            .slice(-4)
            .map((turn) => `- ${turn.text.replace(/\s+/g, " ").trim().slice(0, 240)}`)
            .join("\n") || "(none)";
  const sections: string[] = [];
  const goalBody = firstUser.slice(0, 400).trim();
  if (goalBody) sections.push("Goal", goalBody, "");
  const factsBody = typeof facts === "string" ? facts.trim() : "";
  if (factsBody && factsBody !== "(none)") sections.push("Verified facts", factsBody, "");
  if (addrs.length) sections.push("Addresses", addrs.join("\n"), "");
  if (/\bconstraints?\b/i.test(blob)) sections.push("Constraints", "(see seed / transcript)", "");
  const openBody = (lastUser || lastAssistant.slice(0, 400)).trim();
  if (openBody) sections.push("Open", openBody);
  while (sections.length && !sections[sections.length - 1]) sections.pop();
  let text = sections.join("\n");
  const budgetChars = maxTokens * 4;
  if (text.length > budgetChars) text = `${text.slice(0, Math.max(0, budgetChars - 1)).trimEnd()}…`;
  return text;
}

function buildHandoffDistillPrompt(
  handoff: string,
  extractionPrompt: string,
  maxTokens: number,
  memory?: string,
): string {
  const memoryBlock = memory?.trim() && memory.trim() !== handoff.trim()
    ? `Durable MEMORY.md (dead ends only — do not promote vestigial addresses into Addresses):\n${memory.trim()}\n\n`
    : "";
  return (
    `${extractionPrompt}\n\n` +
    `Token budget for the output: ${maxTokens}. Open (when present) must fit inside that budget.\n\n` +
    memoryBlock +
    "Source (this disk handoff is the truth; do not invent; do not use a chat transcript):\n" +
    handoff.trim()
  );
}

function buildSummarizerPrompt(
  turns: FacingTurn[],
  previousSummary: string | undefined,
  extractionPrompt: string,
  maxTokens: number,
  seed?: string,
  microLedger?: string,
  lastTurn?: { userText?: string; assistantText?: string },
): string {
  const body = turns
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${stubBulkPadText(turn.text)}`)
    .join("\n\n");
  const prior = previousSummary?.trim()
    ? `Previous state vector (lossy — prefer quoting the notebook / last turn when they disagree):\n${previousSummary.trim()}\n\n`
    : "";
  const hasNotebook = Boolean(microLedger?.trim());
  const seedBlock = seed?.trim()
    ? hasNotebook
      ? `Durable MEMORY.md / handoff (constraints only if still clearly relevant — do NOT copy old dogfood canaries or Verified facts from here when the notebook below contradicts or covers the task):\n${seed.trim()}\n\n`
      : `Workspace seed (MEMORY.md / latest handoff — prefer this over tool chips):\n${seed.trim()}\n\n`
    : "";
  const notebook = hasNotebook
    ? `PRIMARY TRUTH — Live notebook stack (seed + appended turn pages since last refresh):\n${microLedger!.trim()}\n\n` +
      "Fold the ENTIRE notebook stack above into one long quality-preserving state vector. " +
      "Do not drop uncontradicted Goal / This turn facts / Verified facts / Addresses / Landmines from any page. " +
      "Prefer length and fidelity over aggressive compression (tens of k characters is OK; soft host cap only).\n" +
      "Truth sources: this notebook stack + the Last turn below. Do not promote unrelated bot MEMORY canaries into Verified facts when a notebook is present.\n" +
      "Merge rule: uncontradicted Verified facts / Addresses / Landmines from the prior vector and this notebook must not be dropped.\n" +
      "Include This turn when useful (last move that mattered). Open: unfinished work or a real pending decision — omit Open if nothing is open. Never soft-park (provide a prompt, await user, wait for next, done, confirm last turn, provide first/next instruction, ask for a first instruction, verify/search for a previous chat turn, essay from last turn, or transcript meta). Never put Fill #N into Goal or Constraints.\n\n"
    : "";
  const userBit = lastTurn?.userText?.trim() ?? "";
  const asstBit = lastTurn?.assistantText?.trim() ?? "";
  const lastTurnBlock =
    userBit || asstBit
      ? "Last turn (live truth — quote; do not invent):\n" +
        [userBit ? `User: ${stubBulkPadText(userBit)}` : "", asstBit ? `Assistant: ${stubBulkPadText(asstBit)}` : ""]
          .filter(Boolean)
          .join("\n\n") +
        "\n\n"
      : "";
  // When a notebook is present, last turn + notebook are the transcript inputs.
  const transcriptBlock = hasNotebook
    ? lastTurnBlock || (`Transcript (tool chips omitted):\n${body}`)
    : `${lastTurnBlock}Transcript (tool chips omitted):\n${body}`;
  return (
    `${extractionPrompt}\n\n` +
    `Token budget for the output: ${maxTokens}.\n\n` +
    seedBlock +
    prior +
    notebook +
    transcriptBlock
  );
}

/**
 * Side text via a local host::model inject id (Unsloth / oMLX / …).
 * Returns null when the id is not inject, the host is unknown, or the call fails.
 */
export async function summarizeViaLocalHost(
  modelId: string,
  prompt: string,
  maxTokens: number,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const inject = decodeInjectId(modelId);
  if (!inject) return null;
  const host = localHost(inject.host);
  if (!host) return null;
  const controller = new AbortController();
  // Unsloth Gemma with larger max_tokens (e.g. micro at 4096) needs more wall time.
  const timeoutMs = maxTokens >= 2048 ? 90_000 : 45_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${host.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${hostApiKey(host, env)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: inject.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        // Unsloth Gemma often fills reasoning_content and leaves content empty when
        // thinking is on and max_tokens is tight. Side vectors must be visible prose
        // only (never reasoning_content), so disable thinking for this path.
        enable_thinking: false,
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    // Intentionally ignore reasoning_content — Max forbids thoughts in vectors.
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Side-channel LLM text: prefer local inject (decodeInjectId → host chat/completions),
 * then optional generateText. Returns null when both paths fail — callers skip write.
 */
export async function generateSideText(input: {
  modelId?: string | null;
  prompt: string;
  generateText?: ((prompt: string) => Promise<string>) | undefined;
  maxTokens?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const maxTokens = Math.max(256, input.maxTokens ?? 1024);
  if (input.modelId) {
    const viaLocal = await summarizeViaLocalHost(
      input.modelId,
      input.prompt,
      maxTokens,
      input.env ?? process.env,
      input.fetchImpl ?? fetch,
    );
    if (viaLocal) return viaLocal;
  }
  if (input.generateText) {
    try {
      const text = (await input.generateText(input.prompt)).trim();
      return text || null;
    } catch {
      return null;
    }
  }
  return null;
}

function sanitizeVector(text: string, maxTokens: number): string {
  const stripped = demotePadBlobsInVector(
    text
      .split("\n")
      .filter((line) => !RESTART_LANGUAGE.test(line))
      .join("\n")
      .trim(),
  );
  const budgetChars = maxTokens * 4;
  if (stripped.length <= budgetChars) return stripped;
  return `${stripped.slice(0, Math.max(0, budgetChars - 1)).trimEnd()}…`;
}

export async function compactSession(input: {
  transcript: FacingTurn[];
  previousSummary?: string;
  userText: string;
  extractionPrompt?: string;
  maxTokens: number;
  modelId?: string | null;
  generateText?: ((prompt: string) => Promise<string>) | undefined;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Private bot workspace (MEMORY.md home). */
  workspaceDir?: string | null;
  /** Extra folders: pinned cwd, bot.cwd, Instruction paths with seed files. */
  workspaceDirs?: Array<string | null | undefined>;
  /** Pinned working folder for git status. Private MEMORY home is not this. */
  workingCwd?: string | null;
  /** Tests inject git status. `null` skips the spawn; omit to read `workingCwd`. */
  gitWorkingTree?: GitWorkingTree | null;
  /** Tests inject seed text instead of reading the disk. */
  workspaceSeed?: string;
  /** Tests inject a summarizer; production leaves this unset. */
  summarize?: (prompt: string) => Promise<string>;
  /** Optional rolling task notebook.md text (primary truth when non-empty). */
  microLedger?: string;
  /** Latest assistant visible reply on the compacting turn (with userText = last turn). */
  lastAssistantText?: string;
}): Promise<{ summary: string; turnText: string }> {
  const requestedMax = Math.max(256, input.maxTokens);
  const notebookPresentEarly = Boolean(input.microLedger?.trim());
  // Notebook fold: allow a long quality-preserving V (soft char cap → tokens).
  // ~30 token floor already covered by Math.max(256, …) for non-notebook; keep floor explicit.
  const notebookFoldTokens = Math.max(
    NOTEBOOK_FOLD_MIN_TOKENS,
    Math.ceil(NOTEBOOK_FOLD_SOFT_CAP_CHARS / 4),
  );
  const maxTokens = notebookPresentEarly
    ? Math.max(requestedMax, notebookFoldTokens)
    : requestedMax;
  const parts =
    input.workspaceSeed !== undefined
      ? { combined: input.workspaceSeed, newestHandoff: input.workspaceSeed }
      : readWorkspaceSeedParts([input.workspaceDir, ...(input.workspaceDirs ?? [])]);
  const seed = parts.combined;
  const prose = proseTurns(input.transcript);
  const clipped = clipFromTail(prose.length ? prose : input.transcript, Math.max(maxTokens * 8, 4_000));
  const harvested = harvestAddresses(
    seed,
    input.previousSummary,
    input.microLedger,
    ...clipped.map((turn) => turn.text),
  );
  const pointers = harvestWorkPointers(input.transcript, {
    cwd: input.workingCwd,
    ...(Object.prototype.hasOwnProperty.call(input, "gitWorkingTree")
      ? { git: input.gitWorkingTree }
      : {}),
  });
  const handoff = parts.newestHandoff.trim();
  const diskHandoff =
    Boolean(handoff) && (looksLikeHandoff(handoff) || handoff.length >= HANDOFF_AS_VECTOR_MIN_CHARS);
  // Distill a disk handoff into the six-heading page. Never smear the chat over it,
  // and never glue MEMORY.md's dead 0x… list onto Addresses.
  // Notebook-on: always fold via the LLM summarizer path — do not short-circuit to disk handoff.
  if (diskHandoff && !input.summarize && !input.microLedger?.trim()) {
    const extraction = input.extractionPrompt?.trim() || DEFAULT_EXTRACTION_PROMPT;
    const memoryOnly = seed === handoff ? "" : seed.replace(handoff, "").trim();
    let distilled = "";
    if (input.modelId) {
      distilled =
        (await summarizeViaLocalHost(
          input.modelId,
          buildHandoffDistillPrompt(handoff, extraction, maxTokens, memoryOnly),
          maxTokens,
          input.env ?? process.env,
          input.fetchImpl ?? fetch,
        )) ?? "";
    }
    const distilledOk =
      Boolean(distilled) &&
      (looksLikeHandoff(distilled) || extractNextBlock(distilled).length > 0) &&
      !isToolChip(distilled);
    let summary = clipKeepingNext(distilledOk ? distilled : handoff, maxTokens);
    if (distilledOk) {
      summary = mergeHarvestedAddresses(summary, harvestAddresses(handoff, distilled));
    }
    summary = mergeWorkPointers(summary, pointers);
    summary = stripSecretLines(summary);
    summary = clipKeepingNext(mergeLiveUser(summary, input.userText), maxTokens);
    summary = sanitizeForwardOnlyVector(summary, input.userText);
    return { summary, turnText: injectStateVector(summary, input.userText) };
  }
  const prompt = buildSummarizerPrompt(
    clipped,
    input.previousSummary,
    input.extractionPrompt?.trim() || DEFAULT_EXTRACTION_PROMPT,
    maxTokens,
    seed,
    input.microLedger,
    { userText: input.userText, assistantText: input.lastAssistantText },
  );
  let raw = "";
  if (input.summarize) {
    try {
      raw = (await input.summarize(prompt)).trim();
    } catch {
      raw = "";
    }
  }
  if (!raw) {
    raw =
      (await generateSideText({
        modelId: input.modelId,
        prompt,
        generateText: input.generateText,
        maxTokens,
        env: input.env,
        fetchImpl: input.fetchImpl,
      })) ?? "";
  }
  const notebookPresent = Boolean(input.microLedger?.trim());
  // When a rolling notebook is present, it is primary truth — do not invent via
  // extractiveFallback / mergeHarvestedAddresses. Still demote pads in the prompt.
  if (!raw) {
    raw = notebookPresent
      ? input.microLedger!.trim()
      : extractiveFallback(clipped, input.previousSummary, maxTokens, seed, input.microLedger);
  }
  let summary =
    sanitizeVector(raw, maxTokens) ||
    (notebookPresent
      ? input.microLedger!.trim()
      : extractiveFallback(clipped, input.previousSummary, maxTokens, seed, input.microLedger));
  if (!notebookPresent) {
    summary = mergeHarvestedAddresses(summary, harvested);
  }
  summary = mergeWorkPointers(summary, pointers);
  summary = stripSecretLines(summary);
  summary = clipKeepingNext(mergeLiveUser(summary, input.userText), maxTokens);
  summary = sanitizeForwardOnlyVector(summary, input.userText);
  return { summary, turnText: injectStateVector(summary, input.userText) };
}

export function decideSettledPromptTokens(input: {
  reported: number;
  ceiling: number;
  currentSpt?: number | null;
  inject: boolean;
}): {
  lastReported: number;
  nextSpt: number | null; // null = leave SPT unchanged
  ignoreReportedPromptFill: boolean;
} {
  const lastReported = Number.isFinite(input.reported) ? Math.max(0, Math.trunc(input.reported)) : 0;
  const current = input.currentSpt;
  const inflated =
    input.inject &&
    typeof current === "number" &&
    Number.isFinite(current) &&
    ((lastReported > input.ceiling * 1.25 && lastReported > current) ||
      (lastReported > input.ceiling && current < input.ceiling * 0.8));
  if (inflated) {
    return { lastReported, nextSpt: null, ignoreReportedPromptFill: true };
  }
  return {
    lastReported,
    nextSpt: lastReported,
    ignoreReportedPromptFill: false,
  };
}

export function fillTokensFor(input: {
  sessionPromptTokens?: number | null;
  lastReportedPromptTokens?: number | null;
  ignoreReportedPromptFill?: boolean;
  transcript: FacingTurn[];
  userText: string;
}): number {
  // SPT is the last settled prompt fill. Add this turn's paste so a fat
  // message can trip Auto compact on the same turn (every-message recycle).
  // After compact, ignore inflated raw host prompt_tokens until a plausible
  // settle; otherwise take max(SPT, lastReported) so the chip tracks live size.
  const paste = estimateTokens(input.userText);
  let base =
    typeof input.sessionPromptTokens === "number" &&
    Number.isFinite(input.sessionPromptTokens) &&
    input.sessionPromptTokens > 0
      ? Math.floor(input.sessionPromptTokens)
      : estimateTranscriptTokensFor(input.transcript);
  if (
    !input.ignoreReportedPromptFill &&
    typeof input.lastReportedPromptTokens === "number" &&
    Number.isFinite(input.lastReportedPromptTokens) &&
    input.lastReportedPromptTokens > 0
  ) {
    base = Math.max(base, Math.floor(input.lastReportedPromptTokens));
  }
  return base + paste;
}

function estimateTranscriptTokensFor(turns: FacingTurn[]): number {
  let total = 0;
  for (const turn of turns) total += estimateTokens(turn.text);
  return total;
}
