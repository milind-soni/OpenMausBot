// `hookCoverage`: "full" when a hook or protocol delivered untruncated results, "preview" when only the driver's bounded
// preview, "none" when the turn showed no tool activity.
import type { MemoryJournalEntry } from "./memory-journal.ts";
import type { Message } from "./store.ts";

import type { DigestFiles, DigestTool, HookCoverage, TurnDigest } from "../shared/digest.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { toolIdentity } from "../shared/tool-name.ts";
export type { DigestFiles, DigestTool, HookCoverage, TurnDigest } from "../shared/digest.ts";

/** Evidence is observed, never inferred from a provider's brand. */
export function coverageForDriver(_driverKind: string | undefined, fullResults = false, observedTools = false): HookCoverage {
  return fullResults ? "full" : observedTools ? "preview" : "none";
}

export function toolEvidence(activities: readonly Message[], turnId: string): boolean {
  const rows = activities.filter((m) => m.kind === "activity" && m.tool?.itemId && m.turnId === turnId);
  return rows.length > 0 && rows.every((m) => m.tool?.fullResult === true);
}

export const MAX_TOOLS = 8;
export const MAX_FILES = 20;
export const MAX_MEMORY = 20;
export const REPLY_CHARS = 200;
export const RENDER_BYTES = 1_500;

export interface DigestInput {
  turnId: string;
  botId: string;
  threadId: string;
  at: number;
  durationMs: number;
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
    if (m.kind !== "activity" || !m.tool?.itemId || m.turnId !== input.turnId) continue;
    // By identity, not the chip's title, which would carry the unredacted command into an FTS-indexed, replayed row.
    const identity = toolIdentity(m.tool.name);
    const entry = byName.get(identity) ?? { name: fitBytes(identity, 160), count: 0, failed: 0 };
    entry.count += 1;
    if (m.tool.ok === false) entry.failed += 1;
    // The driver's summary is the bounded, redacted command; the title is neither.
    if (entry.sample === undefined && m.tool.summary) entry.sample = fitBytes(m.tool.summary.replace(/\s+/g, " "), 300);
    byName.set(identity, entry);
  }
  const ranked = [...byName.values()].sort((a, b) => b.count - a.count);
  const tools = ranked.slice(0, MAX_TOOLS);
  const toolsDropped = ranked.length - tools.length;

  const memory = input.memory.slice(0, MAX_MEMORY).map((row) => ({
    path: fitBytes(row.path, 512),
    kind: (row.kind === "edited" ? "updated" : row.kind) as "created" | "updated" | "deleted",
  }));

  const digest: TurnDigest = {
    turnId: input.turnId,
    botId: input.botId,
    threadId: input.threadId,
    at: input.at,
    durationMs: input.durationMs,
    tools,
    toolCalls: ranked.reduce((sum, tool) => sum + tool.count, 0),
    ...(toolsDropped > 0 ? { toolsDropped } : {}),
    ...(input.files ? { files: boundFiles(input.files) } : {}),
    memory,
    ...(input.memory.length > memory.length ? { memoryDropped: input.memory.length - memory.length } : {}),
    // The digest's copy of the reply is stored and replayed like the reply itself, so it is scrubbed the same way.
    reply: firstSentence(redactSecretsInText(input.reply)),
    ...(input.usage ? { usage: input.usage } : {}),
    hookCoverage: input.hookCoverage,
  };
  return digest;
}

function boundFiles(files: DigestFiles): DigestFiles {
  let budget = MAX_FILES;
  let truncated = files.truncated ?? 0;
  const take = (list: string[]) => {
    const kept = list.slice(0, Math.max(0, budget)).map(path => fitBytes(path, 512));
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

export function renderDigest(d: TurnDigest): string {
  const parts: string[] = ["[digest]"];
  if (d.tools.length) {
    // Every entry ends at "×N" or "(N failed)": the phones split the tools part on exactly that.
    parts.push(`tools: ${digestTools(d)}${d.hookCoverage === "preview" ? " (from tool previews)" : ""}`);
  } else if (d.hookCoverage === "none") {
    parts.push("no tool activity observed in this turn");
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
  if (d.memoryDropped) parts.push(`+${d.memoryDropped} more memory changes`);
  if (d.reply) parts.push(`reply: ${d.reply}`);
  return fitBytes(parts.join(" · "), RENDER_BYTES);
}

export function digestTools(d: Pick<TurnDigest, "tools" | "toolsDropped">): string {
  const tools = d.tools.map((t) => `${t.name} ×${t.count}${t.failed ? ` (${t.failed} failed)` : ""}`).join(", ");
  return `${tools}${d.toolsDropped ? ` +${d.toolsDropped} more` : ""}`;
}

/** Never multi-line, so it sits in a transcript replay or a room window like any speaker line. */
export function digestPromptLine(d: TurnDigest, botName: string): string {
  const body = renderDigest(d).replace(/^\[digest\]\s*/, "").replace(/\s+/g, " ").trim();
  return `[What ${botName} did in an earlier turn: ${body}]`;
}

function fitBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const marker = " […]";
  let out = "";
  let bytes = Buffer.byteLength(marker);
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > max) break;
    out += character;
  }
  return out + marker;
}
