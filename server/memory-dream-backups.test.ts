import { existsSync, unlinkSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupDreamMemory, listDreamBackups, restoreDreamMemory, recoverDreamRestore } from "./memory-dream-backups.ts";
import { ensureWorkspace, workspaceDir, writeMemoryFile, writeMemoryTopic, searchMemoryFiles } from "./workspace.ts";
import { flushMemoryJournal, readMemoryJournal } from "./memory-journal.ts";

const bot = "backup-fixture";
describe("dream memory backups", () => {
  it("keeps five complete backups and verifies their bytes before restoring", async () => {
    ensureWorkspace(bot);
    writeMemoryFile(bot, "original");
    writeMemoryTopic(bot, "project.md", "blueberry original");
    const first = backupDreamMemory(bot, "about original");
    expect(first.files.map((f) => f.path)).toEqual(expect.arrayContaining(["MEMORY.md", "memory/project.md", "About me"]));
    writeMemoryFile(bot, "changed");
    writeMemoryTopic(bot, "new.md", "new");
    let about = "changed profile";
    let currentHash = "";
    try { restoreDreamMemory(bot, { id: first.id }, { read: () => about, write: (s) => { about = s; } }); }
    catch (e: any) { expect(e.code).toBe("changed"); currentHash = e.currentHash; }
    expect(currentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(workspaceDir(bot), "MEMORY.md"), "utf8")).toBe("changed");
    restoreDreamMemory(bot, { id: first.id, expectedHash: currentHash }, { read: () => about, write: (s) => { about = s; } });
    expect(about).toBe("about original");
    expect(readFileSync(join(workspaceDir(bot), "MEMORY.md"), "utf8")).toBe("original");
    expect(searchMemoryFiles(bot, "blueberry").every((hit) => !hit.file.includes(".dream-backups"))).toBe(true);
    await flushMemoryJournal(bot);
    expect(readMemoryJournal(bot).some((row) => row.via === "dream-restore")).toBe(true);
    for (let i = 0; i < 6; i++) backupDreamMemory(bot, about);
    expect(listDreamBackups(bot)).toHaveLength(5);
    const newest = listDreamBackups(bot)[0]!;
    writeFileSync(join(workspaceDir(bot), ".dream-backups", newest.id, "0"), "tampered");
    expect(() => restoreDreamMemory(bot, { id: newest.id }, { read: () => about, write: () => {} })).toThrow();
  });
  it("rejects links and traversal before reading or changing live files", () => {
    ensureWorkspace("links");
    mkdirSync(join(workspaceDir("links"), ".dream-backups"));
    symlinkSync(join(workspaceDir(bot), ".dream-backups"), join(workspaceDir("links"), ".dream-backups", "linked"), "dir");
    expect(() => restoreDreamMemory("links", { id: "../backup-fixture" })).toThrow();
    expect(() => restoreDreamMemory("links", { id: "linked" })).toThrow();
  });
});

it("rolls back all files when the profile write fails", () => {
  ensureWorkspace("rollback");
  writeMemoryFile("rollback", "old notebook");
  const backup = backupDreamMemory("rollback", "old profile");
  writeMemoryFile("rollback", "new notebook");
  let profile = "new profile";
  const access = { read: () => profile, write: (text: string) => { if (text === "old profile") throw new Error("fixture failure"); profile = text; } };
  let expectedHash: string | undefined;
  try { restoreDreamMemory("rollback", { id: backup.id }, access); } catch (e: any) { expectedHash = e.currentHash; }
  expect(() => restoreDreamMemory("rollback", { id: backup.id, expectedHash }, access)).toThrow("fixture failure");
  expect(readFileSync(join(workspaceDir("rollback"), "MEMORY.md"), "utf8")).toBe("new notebook");
  expect(profile).toBe("new profile");
});

it("recovers an interrupted restore from the durable rollback snapshot", () => {
  ensureWorkspace("recovery");
  writeMemoryFile("recovery", "before restore");
  const recovery = backupDreamMemory("recovery");
  writeFileSync(join(workspaceDir("recovery"), ".dream-backups", "restore.json"), JSON.stringify({ id: recovery.id }));
  writeMemoryFile("recovery", "half applied restore");
  recoverDreamRestore("recovery");
  expect(readFileSync(join(workspaceDir("recovery"), "MEMORY.md"), "utf8")).toBe("before restore");
});

it("records absence without creating a notebook and restores that absence", () => {
  ensureWorkspace("absent");
  const path = join(workspaceDir("absent"), "MEMORY.md");
  unlinkSync(path);
  const backup = backupDreamMemory("absent");
  expect(backup.absent).toEqual(["MEMORY.md"]);
  expect(existsSync(path)).toBe(false);
  writeMemoryFile("absent", "new notebook");
  let expectedHash: string | undefined;
  try { restoreDreamMemory("absent", { id: backup.id }); } catch (e: any) { expectedHash = e.currentHash; }
  restoreDreamMemory("absent", { id: backup.id, expectedHash });
  expect(existsSync(path)).toBe(false);
});
