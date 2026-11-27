import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairMovedWorkspacePaths } from "./moved-paths-repair.ts";

const RESTORE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WINDOWS = "C:\\Users\\Ada\\.openmausbot";
const scratch: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "omb-moved-paths-"));
  scratch.push(path);
  return path;
}
function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value)); }
function readJson(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }
function text(path: string): string { return readFileSync(path, "utf8"); }
function receipt(dataDir: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(join(dataDir, ".backups"), { recursive: true });
  const path = join(dataDir, ".backups", "last-restore.json");
  json(path, { restored: true, id: RESTORE_ID, ...extra });
  return path;
}
// A Cloud moved from a Windows PC before v0.1.110: a path field was rebased only when cased like the PC's data
// folder, and instructions, room notes, routine prompts and memory still name that folder.
function movedFromWindows(dataDir: string): void {
  json(join(dataDir, "bots.json"), [
    { id: "bot", threadId: "thread", cwd: "C:\\Users\\Ada\\Projects\\site", soul: `Read ${WINDOWS}\\files\\brief.md before you start.`, tasks: [
      { threadId: "thread", cwd: "c:\\users\\ada\\.openmausbot\\task-workspaces\\bot\\thread", resumeCursors: { codex: "kept" } },
    ] },
  ]);
  json(join(dataDir, "groups.json"), [{ id: "room", memberIds: ["bot"], bulletin: `Shared notes live in ${WINDOWS}\\files.` }]);
  json(join(dataDir, "routines.json"), { version: 1, routines: [
    { id: "on", botId: "bot", enabled: true, prompt: `Each morning read ${WINDOWS}\\files\\brief.md and C:\\Users\\Ada\\Desktop\\x.docx.` },
    { id: "off", botId: "bot", enabled: false, prompt: `Save the summary to ${WINDOWS}\\files\\out.` },
  ], runs: [] });
  mkdirSync(join(dataDir, "workspaces", "bot", "memory"), { recursive: true });
  writeFileSync(join(dataDir, "workspaces", "bot", "MEMORY.md"),
    "- The register: c:\\users\\ada\\.openmausbot\\files\\register.xlsx\n- C:\\Users\\Ada\\.openmausbot-old\\notes.md is an old copy\n");
  writeFileSync(join(dataDir, "workspaces", "bot", "memory", "people.md"), "Ada prefers short replies.\n");
  mkdirSync(join(dataDir, "bots", "bot"), { recursive: true });
  writeFileSync(join(dataDir, "bots", "bot", "SOUL.md"), `Read ${WINDOWS}\\files\\brief.md before you start.`);
}
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The repair runs on Cloud homes, which are Linux; on Windows the data folder is itself a drive path.
describe("repairing paths a move to My Cloud left behind", () => {
  it.skipIf(process.platform === "win32")("rewrites a Windows PC's data folder wherever it is still written, and keeps each routine on or off", () => {
    const dataDir = directory();
    receipt(dataDir);
    movedFromWindows(dataDir);

    expect(repairMovedWorkspacePaths(dataDir)).toEqual([
      "bots.json", "groups.json", "routines.json", "bots/bot/SOUL.md", "workspaces/bot/MEMORY.md",
    ]);

    const [bot] = readJson(join(dataDir, "bots.json"));
    expect(bot).not.toHaveProperty("cwd");
    expect(bot.soul).toBe(`Read ${dataDir}/files/brief.md before you start.`);
    expect(bot.tasks).toEqual([{ threadId: "thread", cwd: join(dataDir, "task-workspaces", "bot", "thread"), resumeCursors: { codex: "kept" } }]);
    expect(readJson(join(dataDir, "groups.json"))[0].bulletin).toBe(`Shared notes live in ${dataDir}/files.`);
    expect(readJson(join(dataDir, "routines.json")).routines).toEqual([
      { id: "on", botId: "bot", enabled: true, prompt: `Each morning read ${dataDir}/files/brief.md and C:\\Users\\Ada\\Desktop\\x.docx.` },
      { id: "off", botId: "bot", enabled: false, prompt: `Save the summary to ${dataDir}/files/out.` },
    ]);
    expect(text(join(dataDir, "workspaces", "bot", "MEMORY.md")))
      .toBe(`- The register: ${dataDir}/files/register.xlsx\n- C:\\Users\\Ada\\.openmausbot-old\\notes.md is an old copy\n`);
    expect(text(join(dataDir, "workspaces", "bot", "memory", "people.md"))).toBe("Ada prefers short replies.\n");
    expect(text(join(dataDir, "bots", "bot", "SOUL.md"))).toBe(bot.soul);
  });

  it("keeps the earlier copy of every file it changes", () => {
    const dataDir = directory();
    receipt(dataDir);
    movedFromWindows(dataDir);
    const before = text(join(dataDir, "workspaces", "bot", "MEMORY.md"));

    repairMovedWorkspacePaths(dataDir);

    const kept = join(dataDir, ".backups", `path-repair-${RESTORE_ID}`);
    expect(text(join(kept, "workspaces", "bot", "MEMORY.md"))).toBe(before);
    expect(readJson(join(kept, "routines.json")).routines[0].prompt).toContain(`${WINDOWS}\\files\\brief.md`);
    expect(existsSync(join(kept, "workspaces", "bot", "memory", "people.md"))).toBe(false);
  });

  it("runs once for a move", () => {
    const dataDir = directory();
    const path = receipt(dataDir);
    movedFromWindows(dataDir);
    repairMovedWorkspacePaths(dataDir);
    expect(readJson(path)).toEqual({ restored: true, id: RESTORE_ID, pathsRewritten: true });
    const later = `Ada's old PC kept these in ${WINDOWS}\\files.\n`;
    writeFileSync(join(dataDir, "workspaces", "bot", "MEMORY.md"), later);

    expect(repairMovedWorkspacePaths(dataDir)).toBeNull();
    expect(text(join(dataDir, "workspaces", "bot", "MEMORY.md"))).toBe(later);
  });

  it.skipIf(process.platform === "win32")("rewrites a Mac's data folder too", () => {
    const dataDir = directory();
    receipt(dataDir);
    json(join(dataDir, "routines.json"), { version: 1, routines: [{ id: "r", botId: "bot", enabled: true, prompt: "Read /Users/ada/.openmausbot/files/brief.md." }], runs: [] });

    expect(repairMovedWorkspacePaths(dataDir)).toEqual(["routines.json"]);
    expect(readJson(join(dataDir, "routines.json")).routines[0].prompt).toBe(`Read ${dataDir}/files/brief.md.`);
  });

  it("changes nothing when the files name more than one other computer's data folder", () => {
    const dataDir = directory();
    const path = receipt(dataDir);
    movedFromWindows(dataDir);
    writeFileSync(join(dataDir, "workspaces", "bot", "memory", "people.md"), "Bob's notes are in C:\\Users\\Bob\\.openmausbot\\files.\n");
    const before = text(join(dataDir, "routines.json"));

    expect(repairMovedWorkspacePaths(dataDir)).toEqual([]);
    expect(text(join(dataDir, "routines.json"))).toBe(before);
    expect(readJson(path).pathsRewritten).toBe(true);
  });

  it("does nothing without a move, or after a move that already rewrote its paths", () => {
    const unmoved = directory();
    movedFromWindows(unmoved);
    const before = text(join(unmoved, "routines.json"));
    expect(repairMovedWorkspacePaths(unmoved)).toBeNull();
    expect(text(join(unmoved, "routines.json"))).toBe(before);

    const current = directory();
    receipt(current, { pathsRewritten: true });
    movedFromWindows(current);
    expect(repairMovedWorkspacePaths(current)).toBeNull();
    expect(text(join(current, "routines.json"))).toBe(before);
  });
});
