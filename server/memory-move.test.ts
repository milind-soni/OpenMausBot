import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { DATA_DIR } from "./config.ts";
import { journalFile, JOURNAL_DIR } from "./memory-journal.ts";
import { moveMemoryLayer } from "./memory-move.ts";
import { ensureWorkspace, isMemorySeed, workspaceDir } from "./workspace.ts";

const at = (layer: string, path: string) => join(workspaceDir(layer), path);
const put = (layer: string, path: string, text: string) => {
  mkdirSync(join(at(layer, path), ".."), { recursive: true });
  writeFileSync(at(layer, path), text);
};

describe("moving one memory layer's notes into another", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("moves the notes, topics, logs and journal, merging with what is there, and leaves an empty memory behind", async () => {
    ensureWorkspace("maus");
    put("maus", "MEMORY.md", "# Memory\n\n- old note\n");
    put("maus", "memory/people.md", "- Ada likes tea\n");
    put("maus", "memory/log/2026-11-01.md", "- talked about tea\n");
    put("maus--member-p", "MEMORY.md", "# Memory\n\n- her own note\n");
    put("maus--member-p", "memory/people.md", "- Ada is in Lisbon\n");
    mkdirSync(JOURNAL_DIR, { recursive: true });
    writeFileSync(journalFile("maus"), `${JSON.stringify({ id: "j1", botId: "maus", at: 1, path: "MEMORY.md", before: "x", canRevert: true })}\n`);

    expect(await moveMemoryLayer("maus", "maus--member-p")).toBe(true);
    expect(readFileSync(at("maus--member-p", "MEMORY.md"), "utf8")).toMatch(/her own note[\s\S]*old note/);
    expect(readFileSync(at("maus--member-p", "memory/people.md"), "utf8")).toMatch(/Lisbon[\s\S]*tea/);
    expect(readFileSync(at("maus--member-p", "memory/log/2026-11-01.md"), "utf8")).toContain("talked about tea");
    expect(isMemorySeed(readFileSync(at("maus", "MEMORY.md"), "utf8"))).toBe(true);
    expect(existsSync(at("maus", "memory/people.md"))).toBe(false);
    expect(existsSync(journalFile("maus"))).toBe(false);
    const row = JSON.parse(readFileSync(journalFile("maus--member-p"), "utf8").trim());
    expect(row).toMatchObject({ id: "j1", botId: "maus--member-p", before: null, canRevert: false });
  });

  it("moves nothing from a memory that holds nothing", async () => {
    ensureWorkspace("empty");
    expect(await moveMemoryLayer("empty", "empty--member-p")).toBe(false);
    expect(await moveMemoryLayer("missing", "missing--member-p")).toBe(false);
  });
});

it.each([
  ["en", "This note moved here from where the bot kept it before, so it can't be reverted here."],
  ["pt-br", "Esta nota veio de onde o bot a guardava antes, então não é possível reverter a alteração aqui."],
  ["de", "Diese Notiz wurde von dort hierher verschoben, wo der Bot sie zuvor aufbewahrte. Deshalb kann sie hier nicht zurückgesetzt werden."],
])("a moved note keeps its explanation in %s", async (language, reason) => {
  const from = `from-${language}`, into = `into-${language}`;
  ensureWorkspace(from);
  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(journalFile(from), `${JSON.stringify({ id: "moved-note", botId: from, at: 1, path: "MEMORY.md", canRevert: true })}\n`);
  await moveMemoryLayer(from, into, language);
  const row = JSON.parse(readFileSync(journalFile(into), "utf8").trim());
  expect(row).toMatchObject({ before: null, canRevert: false, revertUnavailableReason: reason });
});
