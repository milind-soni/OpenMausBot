// "Forget X" reaches every note a bot keeps: MEMORY.md, its topic notes and their archive. About me is forgotten by the caller.
import { join } from "node:path";

import type { AboutMe } from "./about-me.ts";
import { parseMemoryEntries, passageMatcher } from "./memory-entries.ts";
import { clearForgotten, rememberForgotten } from "./profile-learned.ts";
import { isMemorySeed, listMemoryTopics, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic, type MemoryUpdate, type MemoryUpdateResult } from "./workspace.ts";

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** `text` without each note that mentions the passage: a dated entry judged by its fact, never by its source, and any
 * other line whole. Headings, blank lines and a topic's frontmatter stay. */
export function withoutMentions(text: string, mentions: (text: string) => boolean): { text: string; removed: string[] } {
  const lines = text.split("\n");
  const drop = new Set<number>();
  const entryLines = new Set<number>();
  const removed: string[] = [];
  for (const entry of parseMemoryEntries(text)) {
    for (let line = entry.line; line < entry.end; line += 1) entryLines.add(line);
    if (!mentions(entry.body)) continue;
    for (let line = entry.line; line < entry.end; line += 1) drop.add(line);
    removed.push(entry.body);
  }
  let frontmatter = lines[0]?.trim() === "---";
  lines.forEach((line, index) => {
    if (index > 0 && frontmatter && line.trim() === "---") {
      frontmatter = false;
      return;
    }
    if (frontmatter || entryLines.has(index) || line.trim().startsWith("#")) return;
    const bare = line.replace(BULLET, "").replace(/~~/g, "").trim();
    if (!bare || !mentions(bare)) return;
    drop.add(index);
    removed.push(bare);
  });
  return { text: lines.filter((_, index) => !drop.has(index)).join("\n"), removed };
}

function readNote(botId: string, relative: string): string | null {
  try {
    return readMemoryText(join(workspaceDir(botId), relative));
  } catch {
    return null;
  }
}

/** The facts removed, from MEMORY.md first. Each file is read and rewritten with no await in between. */
export function forgetInNotes(botId: string, mentions: (text: string) => boolean): string[] {
  const removed: string[] = [];
  const index = readNote(botId, "MEMORY.md");
  if (index !== null && !isMemorySeed(index)) {
    const kept = withoutMentions(index, mentions);
    if (kept.removed.length) {
      writeMemoryFile(botId, kept.text);
      removed.push(...kept.removed);
    }
  }
  for (const topic of listMemoryTopics(botId)) {
    const text = readNote(botId, join("memory", topic.name));
    if (text === null) continue;
    const kept = withoutMentions(text, mentions);
    if (!kept.removed.length) continue;
    writeMemoryTopic(botId, topic.name, kept.text);
    removed.push(...kept.removed);
  }
  return removed;
}

/** The person's own words started this turn: not another person's, not another bot's, not a room's. */
export function ownersOwnAsk(path: ReadonlyArray<{ role: string; kind?: string; sender?: unknown; peerAsk?: unknown }>): boolean {
  const asked = path.findLast((message) => message.role === "user" && message.kind === "text");
  return Boolean(asked) && !asked!.sender && !asked!.peerAsk;
}

export type BotMemoryResult = MemoryUpdateResult | { ok: true; forgotten: string[]; aboutMe: string[] };

/** memory_update from a bot's turn. forget takes the passage in oldText; `aboutMe` is null when this conversation may not
 * change the person's About me. */
export function botMemoryUpdate(
  layer: string,
  body: { action?: unknown; text?: unknown; oldText?: unknown; until?: unknown },
  opts: { source: string; aboutMe: Pick<AboutMe, "forget"> | null },
): BotMemoryResult {
  if (body.action === "forget") {
    const passage = typeof body.oldText === "string" ? body.oldText : "";
    const mentions = passageMatcher(passage);
    if (!mentions) return { ok: false, code: "invalid", error: "forget needs old_text: a few words that name what to forget, at least three letters." };
    const forgotten = forgetInNotes(layer, mentions);
    if (!opts.aboutMe) return { ok: true, forgotten, aboutMe: [] };
    const aboutMe = opts.aboutMe.forget(layer, mentions);
    rememberForgotten(passage, mentions);
    return { ok: true, forgotten, aboutMe };
  }
  if (body.action === "append" && typeof body.text === "string") clearForgotten(body.text);
  return updateMemory(layer, { action: body.action, text: body.text, oldText: body.oldText, ...(body.until !== undefined ? { until: body.until } : {}) } as MemoryUpdate, { source: opts.source });
}
