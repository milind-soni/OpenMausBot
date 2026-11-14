// A move's memory: each bot's notes, topics and daily logs with its memory journal, what bots learned about the person,
// and each team's shared context and memory, merged into My Cloud's own so nothing is lost and nothing is doubled. This
// computer answers GET /api/cloud-send/memory (with `bot`: that bot's); My Cloud merges POST /api/cloud-send/memory
// over its owner's session. Admin scope.
import { createHash } from "node:crypto";
import { z } from "zod";

import type { CloudOwner } from "./cloud-owner-lines.ts";
import { factIdentity, parseMemoryEntries } from "./memory-entries.ts";
import { adoptMemoryJournal, journalMemoryWrite, readMemoryJournal, type MemoryJournalEntry } from "./memory-journal.ts";
import { MEMORY_INDEX, memoryOverview, parseMemoryPath, readMemoryDoc } from "./memory-store.ts";
import { adoptLearned, learnedState, type LearnedFact } from "./profile-learned.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import { readSectionContext, readSections, sectionContextKey, writeSectionContext } from "./section-context.ts";
import type { BotRecord } from "./store.ts";
import type { TeamMemory, TeamMemoryEntry } from "./team-memory.ts";
import { readMemoryFile } from "./workspace.ts";

const MEMORY_BODY_MAX = 16 * 1024 * 1024;
const JOURNAL_ROWS = 500;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/u;

export interface MoveMemoryDeps {
  bot(id: string): BotRecord | undefined;
  teamMemory: Pick<TeamMemory, "list" | "adopt">;
  aboutMe(): string;
  saveAboutMe(text: string): void;
  owner(auth: RequestAuth): CloudOwner | null;
}

/** One piece of a memory file as a merge compares it: a dated entry with the lines it runs over, or any other line. */
function blocks(text: string): Array<{ text: string; identity: string }> {
  const lines = text.split("\n");
  const entries = new Map(parseMemoryEntries(text).map((entry) => [entry.line, entry]));
  const out: Array<{ text: string; identity: string }> = [];
  for (let line = 0; line < lines.length;) {
    const entry = entries.get(line);
    if (entry) {
      out.push({ text: lines.slice(entry.line, entry.end).join("\n"), identity: `e:${factIdentity(entry.body)}` });
      line = entry.end;
      continue;
    }
    if (lines[line]!.trim()) out.push({ text: lines[line]!, identity: `l:${factIdentity(lines[line]!.replace(/~~/gu, ""))}` });
    line += 1;
  }
  return out;
}

/** The identities of a memory file's pieces, in short hashes: what a move's check compares. */
export function memoryLines(text: string): string[] {
  const body = text.replace(FRONTMATTER, "");
  return [...new Set(blocks(body).map((block) => createHash("sha256").update(block.identity).digest("hex").slice(0, 12)))];
}

/** My Cloud's file with each piece of this computer's it lacks added after its own, in order: the same fact, however it
 * was dated or marked since, counts once. A file My Cloud lacks arrives as it is. */
export function mergeMemoryText(theirs: string, mine: string): string {
  if (!theirs.trim()) return mine;
  const front = FRONTMATTER.exec(mine)?.[0] ?? "";
  const known = new Set(blocks(theirs.replace(FRONTMATTER, "")).map((block) => block.identity));
  const adding: string[] = [];
  for (const block of blocks(mine.slice(front.length))) {
    if (known.has(block.identity)) continue;
    known.add(block.identity);
    adding.push(block.text);
  }
  const base = !FRONTMATTER.test(theirs) && front ? `${front}${theirs}` : theirs;
  return adding.length ? `${base.replace(/\s*$/u, "")}\n${adding.join("\n")}\n` : base;
}

/** A bot's memory files with words in them, its index unless it is only the starter text. */
export function memoryFiles(botId: string): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  const index = readMemoryFile(botId).text;
  if (index.trim()) files.push({ path: MEMORY_INDEX, text: index });
  let overview;
  try { overview = memoryOverview(botId); } catch { return files; }
  for (const file of [...overview.topics, ...overview.logs]) {
    const doc = readMemoryDoc(botId, file.path);
    if (doc.exists && doc.text.trim()) files.push({ path: file.path, text: doc.text });
  }
  return files;
}

/** Each team's shared context and memory entries; General's too. */
export function teamsHere(teamMemory: Pick<TeamMemory, "list">): Array<{ section: string; context: string | null; memory: TeamMemoryEntry[] }> {
  return ["", ...readSections()].map((section) => ({ section, context: readSectionContext(section)?.text ?? null,
    memory: teamMemory.list(section).map(({ revision: _revision, ...entry }) => entry) }))
    .filter((team) => team.context !== null || team.memory.length);
}

export function journalIds(botId: string): string[] {
  return readMemoryJournal(botId, JOURNAL_ROWS).map((entry) => entry.id);
}

const fileSchema = z.object({ path: z.string().max(300), text: z.string().max(512 * 1024) });
const learnedSchema = z.object({ id: z.string().max(100), text: z.string().max(400), line: z.string().max(600), botId: z.string().max(128), botName: z.string().max(200), at: z.number().finite() });
const mergeSchema = z.object({
  v: z.literal(1),
  bot: z.string().regex(/^[\w-]{1,128}$/u).optional(),
  files: z.array(fileSchema).max(2_000).optional(),
  journal: z.array(z.record(z.string(), z.unknown())).max(JOURNAL_ROWS).optional(),
  about: z.object({ learned: z.array(learnedSchema).max(500), removed: z.array(z.string().max(400)).max(1_000) }).optional(),
  teams: z.array(z.object({ section: z.string().max(60), context: z.string().max(24_000).nullable(), memory: z.array(z.unknown()).max(2_000) })).max(200).optional(),
});

/** Merges what arrived into My Cloud's memory; how many files, journal rows, About me lines and team entries changed,
 * and the files it could not keep. */
async function merge(deps: MoveMemoryDeps, body: z.infer<typeof mergeSchema>) {
  const out = { files: 0, journal: 0, about: 0, teams: 0, failed: [] as string[] };
  if (body.bot) {
    for (const file of body.files ?? []) {
      try {
        parseMemoryPath(file.path);
        const current = file.path === MEMORY_INDEX ? readMemoryFile(body.bot).text : readMemoryDoc(body.bot, file.path).text;
        const next = mergeMemoryText(current, file.text);
        if (next === current) continue;
        journalMemoryWrite(body.bot, file.path, next, { actor: "import", via: "move" });
        out.files++;
      } catch { out.failed.push(file.path); }
    }
    out.journal = await adoptMemoryJournal(body.bot, (body.journal ?? []) as unknown as MemoryJournalEntry[]);
  }
  if (body.about) {
    const adopted = adoptLearned(body.about.learned as LearnedFact[], body.about.removed, deps.aboutMe());
    if (!adopted) out.failed.push("about-me");
    else if (adopted.added) { deps.saveAboutMe(adopted.aboutMe); out.about = adopted.added; }
  }
  for (const team of body.teams ?? []) {
    const section = sectionContextKey(team.section);
    if (team.context?.trim()) {
      const current = readSectionContext(section)?.text ?? "";
      const next = mergeMemoryText(current, team.context);
      if (next !== current) {
        try { writeSectionContext(section, next); out.teams++; } catch { out.failed.push(`team:${section}`); }
      }
    }
    out.teams += deps.teamMemory.adopt(section, team.memory);
  }
  return out;
}

/** False when the path is not this route. */
export async function moveMemoryRoute(deps: MoveMemoryDeps, { req, res, path, method, url, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/memory") return false;
  res.setHeader("cache-control", "no-store");
  if (method === "GET") {
    const botId = url.searchParams.get("bot");
    if (botId === null) json(res, 200, { v: 1, about: learnedState(), teams: teamsHere(deps.teamMemory) });
    else if (!/^[\w-]{1,128}$/u.test(botId) || !deps.bot(botId)) json(res, 404, { error: "no such bot" });
    else json(res, 200, { v: 1, files: memoryFiles(botId), journal: readMemoryJournal(botId, JOURNAL_ROWS).map(({ before: _before, ...entry }) => entry) });
    return true;
  }
  if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
  if (!deps.owner(auth)) { json(res, 403, { error: "Only My Cloud's owner can move memory into it." }); return true; }
  const body = mergeSchema.safeParse(await readBody(req, MEMORY_BODY_MAX));
  if (!body.success) { json(res, 400, { error: "send { v: 1, bot, files, journal } or { v: 1, about, teams }" }); return true; }
  if (body.data.bot && !deps.bot(body.data.bot)) { json(res, 409, { error: "This bot is not on My Cloud yet." }); return true; }
  json(res, 200, { v: 1, ...(await merge(deps, body.data)) });
  return true;
}
