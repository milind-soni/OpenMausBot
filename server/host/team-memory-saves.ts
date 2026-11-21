// "Save to team memory" on a Team Cloud: a line a person chose from a conversation they read goes into the bot's team
// notes (MEMORY.md in the bot's own folder, which every conversation with it reads), saying who added it and when.
// Security invariant: only a person's own request adds one, and only its author or an admin takes one out; the line
// names no conversation, so nothing records where a private one came from.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { journalMemoryWrite } from "../memory-journal.ts";
import { MEMORY_INDEX, MemoryStoreError, readMemoryDoc } from "../memory-store.ts";

export const TEAM_MEMORY_SAVES_FILE = "team-memory-saves.json";
export const TEAM_MEMORY_TEXT_MAX = 1_000;
const MAX_ENTRIES = 5_000;
const WRITE_TRIES = 3;

const entrySchema = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/), botId: z.string().regex(/^[\w-]{1,128}$/), person: z.string().regex(/^p_[\w-]{22}$/),
  line: z.string().max(TEAM_MEMORY_TEXT_MAX + 300), at: z.number(),
});
export type TeamMemoryEntry = z.infer<typeof entrySchema>;

/** One bullet: the words on one line, then who saved them and the day. Words past what one note holds are cut at a word
 * and the note says it was shortened. */
export function teamMemoryLine(text: string, name: string, at: number): string {
  const all = text.replace(/\s+/g, " ").trim();
  const cut = all.length > TEAM_MEMORY_TEXT_MAX ? all.slice(0, TEAM_MEMORY_TEXT_MAX).replace(/\s+\S*$/, "") : all;
  const who = name.replace(/\s+/g, " ").trim().slice(0, 80) || "a teammate";
  const day = new Date(at).toISOString().slice(0, 10);
  return cut === all ? `${all} (saved by ${who}, ${day})` : `${cut}… (shortened; saved by ${who}, ${day})`;
}

const bullets = (text: string): string[] => text.split("\n").map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1]).filter((line): line is string => Boolean(line));

export function createTeamMemorySaves(deps: { dataDir: string; now?: () => number }) {
  const file = join(deps.dataDir, TEAM_MEMORY_SAVES_FILE);
  const now = deps.now ?? Date.now;
  let entries: TeamMemoryEntry[] = [];
  try {
    const parsed = z.array(entrySchema).safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) entries = parsed.data;
  } catch {}
  const save = () => {
    entries = entries.slice(-MAX_ENTRIES);
    writeFileAtomic(file, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
  };
  /** MEMORY.md written against the hash it was read at, so a note the bot writes meanwhile is kept. */
  const rewrite = (botId: string, change: (text: string) => string | null): boolean => {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
      const doc = readMemoryDoc(botId, MEMORY_INDEX);
      const next = change(doc.text);
      if (next === null) return false;
      try {
        journalMemoryWrite(botId, MEMORY_INDEX, next, { actor: "person", via: "team-save", expectedHash: doc.hash });
        return true;
      } catch (error) {
        if (!(error instanceof MemoryStoreError) || error.code !== "conflict") throw error;
      }
    }
    throw new MemoryStoreError("conflict", 409, "The team's notes kept changing. Try again.");
  };
  /** An entry whose line an admin edited or took out of MEMORY.md is gone. */
  const present = (botId: string): TeamMemoryEntry[] => {
    const lines = new Set(bullets(readMemoryDoc(botId, MEMORY_INDEX).text));
    return entries.filter((entry) => entry.botId === botId && lines.has(entry.line));
  };

  return {
    add(input: { botId: string; person: string; name: string; text: string }): TeamMemoryEntry {
      const at = now();
      const line = teamMemoryLine(input.text, input.name, at);
      rewrite(input.botId, (text) => {
        const body = text.replace(/\s+$/, "");
        return body ? `${body}\n- ${line}\n` : `- ${line}\n`;
      });
      const entry: TeamMemoryEntry = { id: randomUUID(), botId: input.botId, person: input.person, line, at };
      entries.push(entry);
      save();
      return entry;
    },
    /** A member's own entries; every entry for an admin. */
    list(botId: string, viewer: { person: string; admin: boolean }): TeamMemoryEntry[] {
      return present(botId).filter((entry) => viewer.admin || entry.person === viewer.person);
    },
    remove(botId: string, id: string, by: { person: string; admin: boolean }): "removed" | "gone" | "not-yours" {
      const entry = entries.find((candidate) => candidate.botId === botId && candidate.id === id);
      if (!entry) return "gone";
      if (!by.admin && entry.person !== by.person) return "not-yours";
      rewrite(botId, (text) => {
        const lines = text.split("\n");
        const at = lines.findIndex((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1] === entry.line);
        if (at < 0) return null;
        lines.splice(at, 1);
        return lines.join("\n");
      });
      entries = entries.filter((candidate) => candidate !== entry);
      save();
      return "removed";
    },
    /** A person left: the lines they saved stay in the team's notes, as anything else they did for the team. */
    personLeft(person: string): void {
      if (!entries.some((entry) => entry.person === person)) return;
      entries = entries.filter((entry) => entry.person !== person);
      save();
    },
  };
}

export type TeamMemorySaves = ReturnType<typeof createTeamMemorySaves>;
