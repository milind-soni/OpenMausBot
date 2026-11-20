import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { passageMatcher } from "./memory-entries.ts";
import { botMemoryUpdate, withoutMentions } from "./memory-forget.ts";
import { closeMessageDb } from "./message-db.ts";
import { workspaceDir, WORKSPACES_DIR, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(WORKSPACES_DIR, { recursive: true, force: true });
});

const kept = '- 2026-10-27 · from chat "Oak Street" · Likes tea\n  With milk.\n';
const address = "- 2026-10-27 · Home address:\n  14 Oak Street\n  Second floor.\n";

it("forgets a passage in a continuation across the notebook, topics and archive", () => {
  const bot = "forget-note-details";
  writeMemoryFile(bot, address + kept);
  writeMemoryTopic(bot, "home.md", address + kept);
  writeMemoryTopic(bot, "archive.md", address + kept);
  expect(botMemoryUpdate(bot, { action: "forget", oldText: "Oak Street" }, { source: "chat", aboutMe: null }))
    .toEqual({ ok: true, forgotten: ["Home address:", "Home address:", "Home address:"], aboutMe: [] });
  for (const name of ["MEMORY.md", "memory/home.md", "memory/archive.md"]) {
    expect(readFileSync(join(workspaceDir(bot), name), "utf8")).toBe(kept);
  }
});

it("matches a passage across wrapped detail lines and removes its whole entry", () => {
  const note = "- 2026-10-27 · Home address:\n  14 Oak\n  Street\n";
  expect(withoutMentions(note + kept, passageMatcher("Oak Street")!))
    .toEqual({ text: kept, removed: ["Home address:"] });
});

it("keeps continuation details when only the source chat names the passage", () => {
  expect(withoutMentions(kept, passageMatcher("Oak Street")!)).toEqual({ text: kept, removed: [] });
});
