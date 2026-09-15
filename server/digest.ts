// The work digest — one bounded record per settled turn of what the turn
// DID (docs/plans/2026-09-14-phase-0-foundation.md, item 0.1).
//
// The transcript stores talk: the user's line, the bot's reply, and a chip
// per tool call. Nothing aggregates those into "this turn ran 30 commands,
// changed retry.ts, and added a memory note", which is exactly what a
// context rebuild (engine switch, rewind, room turn) needs and what a
// teammate will need in Phase 6. This module builds that record from rows
// the harness already has for EVERY engine — activity rows, the memory
// journal, the checkpoint diff — so it is engine-agnostic by construction.
// `hookCoverage` says how good the tool evidence is: "full" when a hook or
// protocol delivered untruncated results, "preview" when the driver's
// bounded preview was all we had, "none" for engines that show no tool
// activity at all (the HTTP chat drivers, the box agent).
//
// Pure functions only: no store, no bus, no I/O. The fold wires them.
import type { MemoryJournalEntry } from "./memory-journal.ts";
import type { Message } from "./store.ts";

export type HookCoverage = "full" | "preview" | "none";

export interface DigestFiles {
  changed: string[];
  added: string[];
  deleted: string[];
  /** How many paths were cut from the lists above to stay within bounds. */
  truncated?: number;
}

export interface DigestTool {
  name: string;
  count: number;
  failed: number;
  /** One redacted one-line sample of the tool's input (the existing chip summary). */
  sample?: string;
}

export interface TurnDigest {
  turnId: string;
  botId: string;
  threadId: string;
  at: number;
  durationMs: number;
  tools: DigestTool[];
  /** Tools beyond the busiest MAX_TOOLS, dropped from `tools`. */
  toolsDropped?: number;
  files?: DigestFiles;
  memory: Array<{ path: string; kind: "created" | "updated" | "deleted" }>;
  /** First sentence of the terminal assistant text, at most REPLY_CHARS. */
  reply: string;
  usage?: { input: number; output: number; cachedInput?: number; costUsd?: number | null };
  hookCoverage: HookCoverage;
}

/** Engines whose turns run where the harness sees no tool activity at all:
 * the OpenAI-compatible chat drivers have no tools, the box agent runs on
 * the box. Their digests carry reply + usage and say so. */
export const TOOLLESS_DRIVER_KINDS: ReadonlySet<string> = new Set(["openai-compat", "grok", "minimax", "boxAgent"]);

export function coverageForDriver(driverKind: string | undefined, fullResults = false): HookCoverage {
  if (driverKind && TOOLLESS_DRIVER_KINDS.has(driverKind)) return "none";
  return fullResults ? "full" : "preview";
}

/** True when every tool row of the turn carries a delivered (untruncated)
 * result — what a PostToolUse hook gives us — so the digest may claim
 * "full" evidence. One preview-only row means the turn is "preview". */
export function toolEvidence(activities: readonly Message[], turnId: string): boolean {
  const rows = activities.filter((m) => m.kind === "activity" && m.tool && m.turnId === turnId);
  return rows.length > 0 && rows.every((m) => m.tool?.fullResult === true);
}

export const MAX_TOOLS = 8;
export const MAX_FILES = 20;
export const REPLY_CHARS = 200;
export const RENDER_BYTES = 1_500;

export interface DigestInput {
  turnId: string;
  botId: string;
  threadId: string;
  at: number;
  durationMs: number;
  /** Every message of the thread is fine; only this turn's activity rows are read. */
  activities: readonly Message[];
  memory: readonly MemoryJournalEntry[];
  files?: DigestFiles;
  reply: string;
  usage?: TurnDigest["usage"];
  hookCoverage: HookCoverage;
}

export function buildTurnDigest(input: DigestInput): TurnDigest {
  const byName = new Map<string, DigestTool>();
  for (const m of input.activities) {
    if (m.kind !== "activity" || !m.tool || m.turnId !== input.turnId) continue;
    const entry = byName.get(m.tool.name) ?? { name: m.tool.name, count: 0, failed: 0 };
    entry.count += 1;
    if (m.tool.ok === false) entry.failed += 1;
    if (entry.sample === undefined && m.tool.summary) entry.sample = m.tool.summary;
    byName.set(m.tool.name, entry);
  }
  // busiest first; ties keep first-seen order (Map preserves insertion)
  const ranked = [...byName.values()].sort((a, b) => b.count - a.count);
  const tools = ranked.slice(0, MAX_TOOLS);
  const toolsDropped = ranked.length - tools.length;

  const memory = input.memory.map((row) => ({
    path: row.path,
    kind: (row.kind === "edited" ? "updated" : row.kind) as "created" | "updated" | "deleted",
  }));

  const digest: TurnDigest = {
    turnId: input.turnId,
    botId: input.botId,
    threadId: input.threadId,
    at: input.at,
    durationMs: input.durationMs,
    tools,
    ...(toolsDropped > 0 ? { toolsDropped } : {}),
    ...(input.files ? { files: boundFiles(input.files) } : {}),
    memory,
    reply: firstSentence(input.reply),
    ...(input.usage ? { usage: input.usage } : {}),
    hookCoverage: input.hookCoverage,
  };
  return digest;
}

function boundFiles(files: DigestFiles): DigestFiles {
  let budget = MAX_FILES;
  let truncated = files.truncated ?? 0;
  const take = (list: string[]) => {
    const kept = list.slice(0, Math.max(0, budget));
    truncated += list.length - kept.length;
    budget -= kept.length;
    return kept;
  };
  const changed = take(files.changed);
  const added = take(files.added);
  const deleted = take(files.deleted);
  return { changed, added, deleted, ...(truncated > 0 ? { truncated } : {}) };
}

function firstSentence(reply: string): string {
  const flat = reply.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.slice(0, REPLY_CHARS);
}

/** The transcript row's text: one paragraph, FTS-indexed, ≤ RENDER_BYTES. */
export function renderDigest(d: TurnDigest): string {
  const parts: string[] = ["[digest]"];
  if (d.tools.length) {
    const tools = d.tools.map((t) => `${t.name} ×${t.count}${t.failed ? ` (${t.failed} failed)` : ""}`).join(", ");
    parts.push(`tools: ${tools}${d.toolsDropped ? ` +${d.toolsDropped} more` : ""}${d.hookCoverage === "preview" ? " (from tool previews)" : ""}`);
  } else if (d.hookCoverage === "none") {
    parts.push("no tool activity visible to the harness for this engine");
  } else {
    parts.push("no tool calls");
  }
  if (d.files) {
    const files: string[] = [];
    if (d.files.changed.length) files.push(`changed ${d.files.changed.join(", ")}`);
    if (d.files.added.length) files.push(`added ${d.files.added.join(", ")}`);
    if (d.files.deleted.length) files.push(`deleted ${d.files.deleted.join(", ")}`);
    if (d.files.truncated) files.push(`+${d.files.truncated} more paths`);
    parts.push(files.length ? `files: ${files.join("; ")}` : "files: none changed");
  }
  if (d.memory.length) parts.push(`memory: ${d.memory.map((m) => `${m.kind} ${m.path}`).join(", ")}`);
  if (d.reply) parts.push(`reply: ${d.reply}`);
  return fitBytes(parts.join(" · "), RENDER_BYTES);
}

/** One bracketed line for a context rebuild — never multi-line, so it sits
 * in a transcript replay or a room window like any other speaker line. */
export function digestPromptLine(d: TurnDigest, botName: string): string {
  const body = renderDigest(d).replace(/^\[digest\]\s*/, "").replace(/\s+/g, " ").trim();
  return `[What ${botName} did in an earlier turn: ${body}]`;
}

/** Trim to a byte budget on a character boundary, marking the cut. */
function fitBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const marker = " […]";
  let out = text;
  while (Buffer.byteLength(out + marker, "utf8") > max && out.length > 0) {
    out = out.slice(0, Math.max(0, out.length - Math.ceil((Buffer.byteLength(out + marker, "utf8") - max) / 2) - 1));
  }
  return out + marker;
}
