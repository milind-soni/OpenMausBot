// Moves one memory layer's notes into another (workspace.ts layers), merging where both hold the same file: MEMORY.md,
// the topics and logs under memory/, and the journal of changes. What moved can't be reverted in its new place, since
// it may have merged with what was there.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { flushMemoryJournal, journalFile, JOURNAL_DIR } from "./memory-journal.ts";
import { ensureWorkspace, isMemorySeed, readMemoryText, syncMemoryIndex, workspaceDir } from "./workspace.ts";

const MOVED = "This note moved here from where the bot kept it before, so it can't be reverted here.";

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function joined(kept: string, added: string): string {
  return kept.trim() ? `${kept.trimEnd()}\n\n${added.trim()}\n` : added;
}

/** True when anything moved. */
export async function moveMemoryLayer(from: string, to: string, language?: string): Promise<boolean> {
  const source = workspaceDir(from);
  if (!existsSync(source)) return false;
  const target = ensureWorkspace(to, language);
  let moved = false;
  const index = join(source, "MEMORY.md");
  const notes = existsSync(index) ? readMemoryText(index) : "";
  if (notes.trim() && !isMemorySeed(notes)) {
    const into = join(target, "MEMORY.md"), kept = readMemoryText(into);
    writeFileAtomic(into, isMemorySeed(kept) ? notes : joined(kept, notes), { mode: 0o600 });
    rmSync(index, { force: true });
    ensureWorkspace(from, language);
    moved = true;
  }
  for (const file of filesUnder(join(source, "memory"))) {
    if (!statSync(file).size) continue;
    const into = join(target, relative(source, file));
    mkdirSync(dirname(into), { recursive: true, mode: 0o700 });
    if (existsSync(into)) {
      writeFileAtomic(into, joined(readFileSync(into, "utf8"), readFileSync(file, "utf8")), { mode: 0o600 });
      rmSync(file, { force: true });
    } else {
      renameSync(file, into);
    }
    moved = true;
  }
  await flushMemoryJournal(from);
  await flushMemoryJournal(to);
  const journal = journalFile(from);
  if (existsSync(journal)) {
    const rows = readFileSync(journal, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.stringify({ ...JSON.parse(line), botId: to, before: null, canRevert: false, revertUnavailableReason: MOVED })]; } catch { return []; }
    });
    mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
    if (rows.length) appendFileSync(journalFile(to), `${rows.join("\n")}\n`, { mode: 0o600 });
    rmSync(journal, { force: true });
    moved ||= rows.length > 0;
  }
  syncMemoryIndex(from);
  syncMemoryIndex(to);
  return moved;
}
