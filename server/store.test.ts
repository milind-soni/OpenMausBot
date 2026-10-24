import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { soulFile, soulHash } from "./bot-folder.ts";
import { flushProfileHistory, readHistory, recordProfileChange } from "./profile-versions.ts";
import { DATA_DIR } from "./config.ts";
import {
  beginMemoryTurn,
  endMemoryTurn,
  flushMemoryJournal,
  journalFile,
  journalMemoryWrite,
  resetMemoryJournalState,
} from "./memory-journal.ts";
import type { ModelSelection } from "./contracts.ts";
import * as mdb from "./message-db.ts";
import { peerAllowKey } from "./peer-approval-key.ts";
import { canAccessTeam } from "./peer-roster.ts";
import { Store, toWireTask, type BotRecord } from "./store.ts";
import { createTeamManifest } from "./team-manifest.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import { SECTION_CONTEXTS_FILE, readSectionContext, writeSectionContext } from "./section-context.ts";
import { TeamComputers } from "./team-computers.ts";
import { allowsTool } from "../shared/tool-scope.ts";
import { FACE_BOX } from "../shared/cursor-face-data.ts";
import { createCustomMascotFitContext, suggestCustomMascotAnchor } from "../shared/custom-mascot-fitting.ts";
import type { CustomMascotPoint } from "../shared/mascot-profile.ts";
import { validateCustomMascotDefinition } from "./custom-mascot-validation.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("retains tool selection across restarts and distinguishes clearing from no tools", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Scoped drafter" });
    store.patchBot(bot.id, { toolScope: { allow: [], deny: ["native:bash", "native:bash"] } } as never);
    expect(new Store(selection).bot(bot.id)).toMatchObject({ toolScope: { allow: [], deny: ["native:bash"] } });
    expect(() => store.patchBot(bot.id, { toolScope: { allow: null } } as never)).toThrow(/tool selection/i);
    store.patchBot(bot.id, { toolScope: undefined } as never);
    expect(new Store(selection).bot(bot.id)).not.toHaveProperty("toolScope");
  });

  it.each([undefined, { allow: ["native:read"] }, { deny: ["native:bash"] }])("does not activate a wider tool selection when saving %j fails", (toolScope) => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { toolScope: { allow: [] }, browser: true });
    const save = vi.spyOn(store as unknown as { saveBots(): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.patchBot(bot.id, { toolScope, browser: false })).toThrow("disk full");
    expect(store.bot(bot.id)).toBe(bot);
    expect(bot.toolScope).toEqual({ allow: [] });
    expect(allowsTool(bot.toolScope, { kind: "native", name: "read" })).toBe(false);
    expect(bot.browser).toBe(false);
    expect(new Store(selection).bot(bot.id)?.toolScope).toEqual({ allow: [] });
    save.mockRestore();
    store.patchBot(bot.id, { toolScope });
    expect(allowsTool(bot.toolScope, { kind: "native", name: "read" })).toBe(true);
    expect(new Store(selection).bot(bot.id)?.toolScope).toEqual(toolScope);
  });

  it("keeps tool revocations effective in memory when persistence fails", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const save = vi.spyOn(store as unknown as { saveBots(): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.patchBot(bot.id, { toolScope: { allow: [] } })).toThrow("disk full");
    expect(allowsTool(bot.toolScope, { kind: "native", name: "read" })).toBe(false);
    save.mockRestore();
  });

  it("does not publish a new restricted bot when its first save fails", () => {
    const store = new Store(selection);
    const save = vi.spyOn(store as unknown as { saveBots(): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.createBot({ name: "Failed restricted creation", toolScope: { allow: [] } })).toThrow("disk full");
    expect(store.bots).toEqual([]);
    save.mockRestore();
    expect(new Store(selection).bots).toEqual([]);
  });

  it("rejects malformed tool selection before creating a bot", () => {
    const store = new Store(selection);
    expect(() => store.createBot({ toolScope: { allow: "all" } } as never)).toThrow(/tool selection/i);
    expect(store.bots).toEqual([]);
    expect(new Store(selection).bots).toEqual([]);
  });

  it("retains corrupt persisted tool selection as denied access instead of inheriting all tools", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Corrupt selection fixture" });
    const bots = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    bots[0].toolScope = { allow: "all" };
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(bots));
    const restored = new Store(selection).bot(bot.id)!;
    expect(restored).toHaveProperty("toolScope", { allow: "all" });
    expect(allowsTool((restored as unknown as { toolScope: unknown }).toolScope, { kind: "native", name: "read" })).toBe(false);
  });

  it("takes a deleted bot out of every room it was in and passes its lead role on", () => {
    const store = new Store(selection);
    const [ada, ben, cleo] = [store.createBot({}), store.createBot({}), store.createBot({})];
    const room = store.createGroup("Launch team", [ada.id, ben.id, cleo.id], false);
    store.patchGroup(room.id, { defaultResponder: { kind: "member", botId: ben.id }, busyBotId: ben.id });
    const pair = store.createGroup("Ada & Ben", [ada.id, ben.id], true);
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));

    expect(store.deleteBot(ben.id)).toBe(true);
    expect(store.group(room.id)).toMatchObject({ memberIds: [ada.id, cleo.id], defaultResponder: { kind: "member", botId: ada.id } });
    expect(store.group(room.id)?.turnStartedAt).toBeUndefined();
    expect(store.group(pair.id)?.memberIds).toEqual([ada.id, ben.id]);
    expect(changes).toContainEqual({ type: "group", groupId: room.id });
    expect(new Store(selection).group(room.id)?.memberIds).toEqual([ada.id, cleo.id]);
  });

  it("finishes bot erasure if the room registry cannot persist, then repairs it on restart", () => {
    const store = new Store(selection);
    const [ada, ben] = [store.createBot({}), store.createBot({})];
    const room = store.createGroup("Launch team", [ada.id, ben.id], false);
    const internals = store as unknown as { saveGroups: () => void };
    vi.spyOn(internals, "saveGroups").mockImplementationOnce(() => { throw new Error("fixture write failure"); });

    expect(store.deleteBot(ben.id)).toBe(true);
    expect(store.bot(ben.id)).toBeNull();
    expect(store.messagesFor(ben.threadId)).toEqual([]);
    expect(existsSync(soulFile(ben.id))).toBe(false);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8"))[0].memberIds).toContain(ben.id);
    expect(new Store(selection).group(room.id)?.memberIds).toEqual([ada.id]);
  });

  it("repairs rooms that still list a deleted bot when it starts", () => {
    const store = new Store(selection);
    const [ada, cleo] = [store.createBot({}), store.createBot({})];
    const room = store.createGroup("Launch team", [ada.id, cleo.id], false);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    const ghost = "8a2acb50-6276-4ce2-926a-9e112b848acc";
    Object.assign(saved.find((g: { id: string }) => g.id === room.id), {
      memberIds: [ghost, ada.id, cleo.id],
      defaultResponder: { kind: "member", botId: ghost },
    });
    writeFileSync(groupsFile, JSON.stringify(saved));

    const restarted = new Store(selection);
    expect(restarted.group(room.id)).toMatchObject({ memberIds: [ada.id, cleo.id], defaultResponder: { kind: "member", botId: ada.id } });
    const persisted = JSON.parse(readFileSync(groupsFile, "utf8")).find((g: { id: string }) => g.id === room.id);
    expect(persisted.memberIds).toEqual([ada.id, cleo.id]);
  });

  it("never empties rooms when the bot list cannot be read", () => {
    const store = new Store(selection);
    const [ada, cleo] = [store.createBot({}), store.createBot({})];
    const room = store.createGroup("Launch team", [ada.id, cleo.id], false);
    const groupsFile = join(DATA_DIR, "groups.json");
    const before = readFileSync(groupsFile, "utf8");
    writeFileSync(join(DATA_DIR, "bots.json"), "{ not json");

    expect(new Store(selection).group(room.id)?.memberIds).toEqual([ada.id, cleo.id]);
    expect(JSON.parse(readFileSync(groupsFile, "utf8")).find((g: { id: string }) => g.id === room.id).memberIds)
      .toEqual(JSON.parse(before).find((g: { id: string }) => g.id === room.id).memberIds);
  });

  it("renames populated teams without changing members, conversations, grants or computer identity", () => {
    const store = new Store(selection);
    const chief = store.createBot({ section: "Delivery" });
    store.setChiefOfStaff(chief.id);
    const archived = store.createBot({ section: "Delivery" });
    store.patchBot(archived.id, { hidden: true });
    const manager = store.createBot({ section: "Office" });
    store.setChiefOfStaff(manager.id);
    store.patchBot(manager.id, { managedSections: ["Delivery", " Delivery ", "Other"] });
    expect(canAccessTeam(manager, "Delivery")).toBe(true);
    const room = store.createGroup("Room", [chief.id], false, "Delivery");
    const message = store.appendMessage(chief.threadId, { role: "user", kind: "text", text: "Keep this conversation" });
    writeSectionContext("Delivery", "Shared team instructions");
    const computers = new TeamComputers(join(DATA_DIR, "team-computers.json"), "5c57ceec-f5aa-4d79-a9c7-0e1f93875e70");
    const computer = computers.create("Shared desktop");
    computers.assign(computer.id, "Delivery");
    expect(store.renameSection("Delivery", "Launch", computers)).toBeUndefined();
    expect(store.bot(chief.id)).toBe(chief);
    expect(chief).toMatchObject({ section: "Launch", chiefOfStaff: true });
    expect(archived).toMatchObject({ section: "Launch", hidden: true });
    expect(manager.managedSections).toEqual(["Launch", "Other"]);
    expect(canAccessTeam(manager, "Launch")).toBe(true);
    expect(room.section).toBe("Launch");
    expect(readSectionContext("Launch")?.text).toBe("Shared team instructions");
    expect(readSectionContext("Delivery")).toBeNull();
    expect(computers.forSection("Launch")?.id).toBe(computer.id);
    const restored = new Store(selection);
    expect(restored.bot(chief.id)?.section).toBe("Launch");
    expect(canAccessTeam(restored.bot(manager.id)!, "Launch")).toBe(true);
    expect(restored.group(room.id)?.section).toBe("Launch");
    expect(restored.messagesFor(chief.threadId)).toContainEqual(message);
    expect(restored.sections).not.toContain("Delivery");
    store.setBotsSection([], "Delivery");
    expect(canAccessTeam(manager, "Delivery")).toBe(false);
  });

  it("rejects rename conflicts and active work without changing teams", () => {
    const store = new Store(selection);
    const bot = store.createBot({ section: "Delivery" });
    store.setBotsSection([], "Existing");
    expect(store.renameSection("Delivery", "Existing")).toContain("already exists");
    expect(store.renameSection("Delivery", "bad\nname")).toContain("control characters");
    bot.busy = true;
    expect(store.renameSection("Delivery", "Launch")).toContain("active work");
    expect(bot.section).toBe("Delivery");
    expect(store.sections).not.toContain("Launch");
  });

  it("restores membership files when a rename cannot save the group registry", () => {
    const store = new Store(selection);
    const bot = store.createBot({ section: "Delivery" });
    const room = store.createGroup("Room", [bot.id], false, "Delivery");
    store.patchBot(bot.id, { title: "General assistant" });
    const disk = () => ["bots.json", "groups.json", "section-contexts.json"].map(name => readFileSync(join(DATA_DIR, name), "utf8"));
    const before = disk();
    const internals = store as unknown as { saveGroups: (...args: unknown[]) => void };
    vi.spyOn(internals, "saveGroups").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => store.renameSection("Delivery", "Launch")).toThrow("disk unavailable");
    expect(disk()).toEqual(before);
    expect(bot.section).toBe("Delivery");
    expect(room.section).toBe("Delivery");
  });

  it("deletes a populated team while preserving bots, archived members and room history across restart", () => {
    const store = new Store(selection);
    const bot = store.createBot({ section: "Studio" });
    const archived = store.createBot({ section: "Studio" });
    store.patchBot(archived.id, { hidden: true });
    const chief = store.createBot({ section: "Office" });
    store.setChiefOfStaff(chief.id);
    store.patchBot(chief.id, { managedSections: ["Studio", "Other"] });
    const room = store.createGroup("Discussion", [bot.id], false, "Studio");
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Keep private history" });
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "Keep shared history" });
    writeSectionContext("Studio", "Old brief");
    writeSectionContext("", "General brief");
    const before = [store.messagesFor(bot.threadId), store.messagesFor(room.threadId)];
    expect(store.deleteSection("Studio")).toBeUndefined();
    const restored = new Store(selection);
    expect(restored.sections).not.toContain("Studio");
    expect(restored.bot(bot.id)).toMatchObject({ threadId: bot.threadId, modelSelection: bot.modelSelection });
    expect(restored.bot(bot.id)?.section).toBeUndefined();
    expect(restored.bot(archived.id)?.hidden).toBe(true);
    expect(restored.bot(archived.id)?.section).toBeUndefined();
    expect(restored.group(room.id)).toMatchObject({ memberIds: [bot.id], threadId: room.threadId });
    expect(restored.group(room.id)?.section).toBeUndefined();
    expect([restored.messagesFor(bot.threadId), restored.messagesFor(room.threadId)]).toEqual(before);
    expect(restored.bot(chief.id)?.managedSections).toEqual(["Other"]);
    expect(readSectionContext("Studio")).toBeNull();
    expect(readSectionContext("")?.text).toBe("General brief");
    restored.createBot({ section: "Studio" });
    expect(restored.bot(chief.id)?.managedSections).toEqual(["Other"]);
  });

  it("refuses active work and Chief conflicts without silently demoting a Chief", () => {
    const store = new Store(selection);
    const chief = store.createBot({ section: "Studio" });
    store.setChiefOfStaff(chief.id);
    store.patchBot(chief.id, { busy: true });
    expect(store.deleteSection("Studio")).toMatch(/Stop/);
    store.patchBot(chief.id, { busy: false });
    const general = store.createBot();
    store.setChiefOfStaff(general.id);
    expect(store.deleteSection("Studio")).toMatch(/Chief/);
    expect(store.bot(chief.id)).toMatchObject({ chiefOfStaff: true, section: "Studio" });
    expect(store.deleteSection("missing")).toBe("No such department");
    expect(store.deleteSection("")).toBe("No such department");
  });

  it("restores persisted membership if deleting the team cannot finish", () => {
    const store = new Store(selection);
    const bot = store.createBot({ section: "Studio" });
    const room = store.createGroup("Discussion", [bot.id], false, "Studio");
    const write = vi.spyOn(store as any, "saveGroups").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => store.deleteSection("Studio")).toThrow("disk unavailable");
    write.mockRestore();
    const restored = new Store(selection);
    expect(restored.bot(bot.id)?.section).toBe("Studio");
    expect(restored.group(room.id)?.section).toBe("Studio");
    expect(store.bot(bot.id)?.section).toBe("Studio");
    expect(restored.sections).toContain("Studio");
  });

  it("persists compaction records but keeps session bookkeeping off the wire", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Original history" });
    const key = "sk-ant-" + "a".repeat(90);
    const record = store.appendMessage(bot.threadId, { role: "bot", kind: "compaction", compaction: {
      summary: `Historical data -5 != 5; ${key}`, firstKeptId: "", foldedThroughId: user.id, tokensBefore: 100, by: "person",
    } });
    const patch = { appliedCompactionId: record.id, contextFloor: 500, lastContextModel: "claude:fixture" };
    store.patchTask(bot.id, bot.threadId, patch);
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)).toMatchObject(patch);
    expect(reloaded.messagesFor(bot.threadId)).toHaveLength(2);
    expect(reloaded.messagesFor(bot.threadId)[1].compaction?.summary).toContain("-5 != 5");
    expect(JSON.stringify(reloaded.messagesFor(bot.threadId))).not.toContain(key);
    const wire = toWireTask(reloaded.taskByThread(bot.id, bot.threadId)!, selection());
    for (const field of Object.keys(patch)) expect(wire).not.toHaveProperty(field);
  });

  it("keeps a Live call row's record across a restart and scrubs a secret from its title", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const key = "sk-ant-" + "c".repeat(90);
    const row = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "call",
      text: "Call with Ada · 1:42",
      call: { callId: "call-1", botId: bot.id, client: "ios", startedAt: 1_000, endedAt: 103_000, seconds: 102, endReason: "hung-up", title: `Deploy with ${key}` },
    });
    expect(row.call?.title).not.toContain(key);
    const reloaded = new Store(selection).messagesFor(bot.threadId).find((message) => message.id === row.id);
    expect(reloaded?.call).toMatchObject({ callId: "call-1", botId: bot.id, client: "ios", seconds: 102, endReason: "hung-up" });
    expect(JSON.stringify(reloaded)).not.toContain(key);
  });

  it("round-trips audio attachments with their metadata through persistence", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const reply = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Voice note attached",
      attachments: [
        { kind: "image", path: "/attachments/shot.png", mime: "image/png" },
        { kind: "audio", path: "/attachments/note.mp3", mime: "audio/mpeg", durationMs: 4200, text: "The spoken words" },
      ],
    });
    expect(reply.attachments?.[1]).toEqual({
      kind: "audio",
      path: "/attachments/note.mp3",
      mime: "audio/mpeg",
      durationMs: 4200,
      text: "The spoken words",
    });
    const reloaded = new Store(selection);
    const stored = reloaded.messagesFor(bot.threadId).find((message) => message.id === reply.id);
    expect(stored?.attachments).toEqual(reply.attachments);
    const encoded = JSON.stringify(stored);
    expect(encoded).toContain('"kind":"audio"');
    expect(encoded).toContain('"durationMs":4200');
    expect(encoded).toContain('"text":"The spoken words"');
  });

  it("keeps surface pin provenance server-private and round-trips it through bots.json", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.patchTask(bot.id, bot.threadId, { surface: "local", surfaceSource: "user" });
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(toWireTask(reloaded.taskByThread(bot.id, bot.threadId)!, selection())).not.toHaveProperty("surfaceSource");
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as any[];
    expect(saved[0].tasks[0]).toMatchObject({ surface: "local", surfaceSource: "user" });
  });

  it("clears only auto surface pins that conflict with a Works on change", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const autoMismatch = store.createTask(bot.id, "Auto mismatch", false)!;
    const personMismatch = store.createTask(bot.id, "Person mismatch", false)!;
    const legacyMismatch = store.createTask(bot.id, "Legacy person mismatch", false)!;
    const autoMatch = store.createTask(bot.id, "Auto match", false)!;
    store.patchTask(bot.id, autoMismatch.threadId, { surface: "local", surfaceSource: "auto" });
    store.patchTask(bot.id, personMismatch.threadId, { surface: "local", surfaceSource: "user" });
    store.patchTask(bot.id, legacyMismatch.threadId, { surface: "local" });
    store.patchTask(bot.id, autoMatch.threadId, { surface: "vm", surfaceSource: "auto" });
    const changes = vi.fn();
    store.onChange(changes);
    expect(store.clearAutoSurfacePins(bot.id, "vm")).toBe(1);
    const cleared = store.taskByThread(bot.id, autoMismatch.threadId)!;
    expect(cleared.surface).toBeUndefined();
    expect(cleared.surfaceSource).toBeUndefined();
    expect(store.taskByThread(bot.id, personMismatch.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(store.taskByThread(bot.id, legacyMismatch.threadId)).toMatchObject({ surface: "local" });
    expect(store.taskByThread(bot.id, autoMatch.threadId)).toMatchObject({ surface: "vm" });
    expect(changes).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as any[];
    const savedCleared = saved[0].tasks.find((task: any) => task.threadId === autoMismatch.threadId);
    expect(savedCleared).not.toHaveProperty("surface");
    expect(savedCleared).not.toHaveProperty("surfaceSource");
    expect(store.clearAutoSurfacePins(bot.id, "vm")).toBe(0);
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, personMismatch.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(reloaded.taskByThread(bot.id, legacyMismatch.threadId)).toMatchObject({ surface: "local" });
    expect(reloaded.taskByThread(bot.id, legacyMismatch.threadId)?.surfaceSource).toBeUndefined();
    expect(reloaded.taskByThread(bot.id, autoMatch.threadId)).toMatchObject({ surface: "vm" });
    expect(reloaded.taskByThread(bot.id, autoMismatch.threadId)!.surface).toBeUndefined();
  });

  it("leaves bots.json alone when a save changes nothing, and writes the next real change", () => {
    const file = join(DATA_DIR, "bots.json");
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.setResumeCursor(bot.id, "claude", { sessionId: "s-1" }, bot.threadId);
    store.patchTask(bot.id, bot.threadId, { lastContextModel: "claude-sonnet-5" });
    const saved = statSync(file).ino;
    const events: unknown[] = [];
    store.onChange((change) => events.push(change));

    store.setResumeCursor(bot.id, "claude", { sessionId: "s-1" }, bot.threadId);
    store.patchTask(bot.id, bot.threadId, { lastContextModel: "claude-sonnet-5" });
    expect(statSync(file).ino).toBe(saved);
    expect(events).toEqual([{ type: "bot", botId: bot.id }, { type: "bot", botId: bot.id }]);

    store.setResumeCursor(bot.id, "claude", { sessionId: "s-2" }, bot.threadId);
    expect(statSync(file).ino).not.toBe(saved);
    expect(new Store(selection).taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ claude: { sessionId: "s-2" } });
  });

  it("still overwrites a bots.json changed on disk when the next save differs from it", () => {
    const file = join(DATA_DIR, "bots.json");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Original" }, { seedMessages: false });
    store.setResumeCursor(bot.id, "claude", { sessionId: "s-1" }, bot.threadId);
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited[0].name = "Edited on disk";
    writeFileSync(file, JSON.stringify(edited, null, 2));

    store.setResumeCursor(bot.id, "claude", { sessionId: "s-1" }, bot.threadId);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].name).toBe("Original");
  });

  it.skipIf(process.platform === "win32")("writes the bot and group registries owner-only and tightens loose ones on load", () => {
    const mode = (name: string) => statSync(join(DATA_DIR, name)).mode & 0o777;
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.createGroup("Team", [bot.id]);
    expect(mode("bots.json")).toBe(0o600);
    expect(mode("groups.json")).toBe(0o600);
    for (const name of ["bots.json", "groups.json"]) chmodSync(join(DATA_DIR, name), 0o644);
    const reloaded = new Store(selection);
    expect(mode("bots.json")).toBe(0o600);
    expect(mode("groups.json")).toBe(0o600);
    expect(reloaded.bots.map((record) => record.id)).toContain(bot.id);
    reloaded.createGroup("Second team", [bot.id]);
    reloaded.createBot({}, { seedMessages: false });
    expect(mode("bots.json")).toBe(0o600);
    expect(mode("groups.json")).toBe(0o600);
  });

  it("commits receipt-backed transcript changes before publishing and replays without duplicates", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const threadId = bot.threadId;
    const before = structuredClone(store.messagesFor(threadId));
    const changes = vi.fn();
    store.onChange(changes);
    const database = new DatabaseSync(join(DATA_DIR, "messages.db"));
    const failReceipts = () => database.exec("CREATE TRIGGER reject_test_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
    const allowReceipts = () => database.exec("DROP TRIGGER reject_test_receipt");
    const append = () => store.appendMessage(threadId, { role: "bot", kind: "text", text: "Recorded work" }, { kind: "test.append", key: threadId });
    try {
      failReceipts();
      expect(append).toThrow("fixture receipt failure");
      expect(store.messagesFor(threadId)).toEqual(before);
      expect(mdb.readThread(threadId, "/nonexistent").messages).toEqual(before);
      expect(changes).not.toHaveBeenCalled();
      allowReceipts();
      const message = append();
      expect(append()).toEqual(message);
      expect(store.messagesFor(threadId)).toHaveLength(before.length + 1);
      expect(changes).toHaveBeenCalledTimes(1);
      changes.mockClear();
      const patch = () => store.patchMessage(threadId, message.id, { text: "Updated evidence" }, { kind: "test.patch", key: message.id });
      failReceipts();
      expect(patch).toThrow("fixture receipt failure");
      expect(store.messagesFor(threadId).at(-1)?.text).toBe("Recorded work");
      expect(mdb.readThread(threadId, "/nonexistent").messages.at(-1)?.text).toBe("Recorded work");
      expect(changes).not.toHaveBeenCalled();
      allowReceipts();
      expect(patch()?.text).toBe("Updated evidence");
      expect(patch()?.text).toBe("Updated evidence");
      expect(changes).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });

  it("commits a confirmed model switch once, moving followers safely and rolling back failed writes", () => {
    const store = new Store(selection, undefined, (instanceId) => ({ claude: "claudeAgent", codex: "codex" })[instanceId]);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full", alwaysAllow: ["old-tool"] });
    const first = store.activeTask(bot.id)!;
    const sibling = store.createTask(bot.id)!;
    const picked = store.createTask(bot.id)!;
    const opus = { instanceId: "claude", model: "claude-opus-5" };
    store.switchTaskModel(bot.id, picked.threadId, opus, false, false);
    const next = { instanceId: "codex", model: "fixture-model" };
    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots");
    store.switchTaskModel(bot.id, first.threadId, next, false, true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.projectBotForTask(bot.id, first.threadId)).toMatchObject({ modelSelection: next, approvalMode: "ask", alwaysAllow: [] });
    expect(bot).toMatchObject({ modelSelection: selection(), approvalMode: "full" });
    expect(sibling).toMatchObject({ approvalMode: "full", alwaysAllow: ["old-tool"] });
    expect(sibling.modelSelection).toBeUndefined();
    delete sibling.approvalMode;
    delete sibling.autoApprove;
    delete sibling.alwaysAllow;
    save.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.switchTaskModel(bot.id, first.threadId, next, true, true)).toThrow("disk full");
    expect(bot).toMatchObject({ modelSelection: selection(), approvalMode: "full" });
    expect(sibling.modelSelection).toBeUndefined();
    store.switchTaskModel(bot.id, first.threadId, next, true, true);
    expect(bot).toMatchObject({ modelSelection: next, approvalMode: "ask", alwaysAllow: [] });
    expect(first.modelSelection).toBeUndefined();
    expect(sibling).toMatchObject({ approvalMode: "full", alwaysAllow: ["old-tool"] });
    expect(store.projectBotForTask(bot.id, sibling.threadId)?.modelSelection).toEqual(next);
    expect(picked).toMatchObject({ modelSelection: opus, approvalMode: "full", alwaysAllow: ["old-tool"] });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({ modelSelection: next, approvalMode: "ask" });
    expect(reloaded.taskByThread(bot.id, sibling.threadId)).toMatchObject({ approvalMode: "full" });
    expect(reloaded.taskByThread(bot.id, picked.threadId)).toMatchObject({ modelSelection: opus, approvalMode: "full" });
  });

  it("createBot seeds a greeting without promising engine-specific tools", () => {
    const store = new Store(selection, undefined, undefined, "en");
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "bot",
      kind: "text",
      text: `Hi, I'm ${bot.name}. What would you like me to do?`,
    });
    expect(bot.modelSelection).toEqual(selection());
  });

  it("reads the current language when creating a bot", () => {
    let language = "en";
    const store = new Store(selection, undefined, undefined, () => language);
    language = "pt-BR";

    const bot = store.createBot();
    expect(store.messagesFor(bot.threadId)[0]?.text).toBe(`Oi, eu sou ${bot.name}. O que você gostaria que eu fizesse?`);
  });

  it("clears provider-owned voice ids as one durable mutation", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    store.patchBot(first.id, { voice: "provider-a-1" });
    store.patchBot(second.id, { voice: "provider-a-2" });

    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots");
    save.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.clearVoiceSelections()).toThrow("disk full");
    expect(first.voice).toBe("provider-a-1");
    expect(second.voice).toBe("provider-a-2");

    expect(store.clearVoiceSelections().map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(first.voice).toBeUndefined();
    expect(second.voice).toBeUndefined();
    const reloaded = new Store(selection);
    expect(reloaded.bot(first.id)?.voice).toBeUndefined();
    expect(reloaded.bot(second.id)?.voice).toBeUndefined();
  });

  it("restarts with legacy bot and group migrations despite an unreadable team registry, without permitting later team writes", () => {
    const original = new Store(selection);
    const bot = original.createBot({ name: "Legacy bot", section: "Research" });
    const group = original.createGroup("Legacy group", [bot.id], false, "Engineering");
    original.appendMessage(group.threadId, { role: "user", kind: "text", text: "Keep the group conversation" });
    const botMessages = original.messagesFor(bot.threadId);
    const groupMessages = original.messagesFor(group.threadId);
    const bots = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    const groups = JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8"));
    delete bots[0].tasks; delete bots[0].soulHash;
    delete groups[0].tasks; delete groups[0].defaultResponder;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(bots));
    writeFileSync(join(DATA_DIR, "groups.json"), JSON.stringify(groups));
    const malformed = '{"version":1,"contexts":';
    writeFileSync(SECTION_CONTEXTS_FILE, malformed);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restored = new Store(selection);
      expect(restored.bot(bot.id)?.tasks?.[0].threadId).toBe(bot.threadId);
      expect(restored.group(group.id)?.tasks?.[0].threadId).toBe(group.threadId);
      expect(restored.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: bot.id });
      expect(restored.messagesFor(bot.threadId)).toEqual(botMessages);
      expect(restored.messagesFor(group.threadId)).toEqual(groupMessages);
      expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].tasks).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8"))[0].tasks).toHaveLength(1);
      expect(warning.mock.calls.some(([message]) => String(message).includes("[teams] Startup could not register"))).toBe(true);
      const beforeBots = structuredClone(restored.bots);
      const beforeGroups = structuredClone(restored.groups);
      const beforeBotsFile = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
      const beforeGroupsFile = readFileSync(join(DATA_DIR, "groups.json"), "utf8");
      expect(() => restored.setBotsSection([bot.id], "Do not create")).toThrow(/left unchanged/);
      expect(() => restored.createBot({ name: "Must not appear", section: "Do not create" })).toThrow(/left unchanged/);
      expect(() => restored.createGroup("Must not appear", [bot.id], false, "Do not create")).toThrow(/left unchanged/);
      expect(() => restored.patchGroup(group.id, { name: "Must not rename", section: "Do not create" })).toThrow(/left unchanged/);
      expect(restored.bots).toEqual(beforeBots);
      expect(restored.groups).toEqual(beforeGroups);
      expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(beforeBotsFile);
      expect(readFileSync(join(DATA_DIR, "groups.json"), "utf8")).toBe(beforeGroupsFile);
      expect(new Store(selection).messagesFor(group.threadId)).toEqual(groupMessages);
      expect(readFileSync(SECTION_CONTEXTS_FILE, "utf8")).toBe(malformed);
    } finally { warning.mockRestore(); }
  });

  it("messagesTail reads a bounded page via SQL on a fresh Store, and older messages still load in full", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    for (let i = 0; i < 10; i++) {
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `message ${i}` });
    }

    // A brand-new Store has never cached this thread, so this exercises the SQL LIMIT path, not an in-memory slice.
    const reloaded = new Store(selection);
    const tail = reloaded.messagesTail(bot.threadId, 3);
    expect(tail.messages.map((m) => m.text)).toEqual(["message 7", "message 8", "message 9"]);
    expect(tail.hasMore).toBe(true);
    expect(tail.activeLeafId).toBe(tail.messages.at(-1)!.id);

    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `message ${i}`),
    );

    const whole = new Store(selection).messagesTail(bot.threadId, 100);
    expect(whole.messages).toHaveLength(10);
    expect(whole.hasMore).toBe(false);
  });

  it("caches a complete tail but never caches a zero-message page as an empty thread", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "keep this" });
    const read = vi.spyOn(mdb, "readThread");
    try {
      const fresh = new Store(selection);
      expect(fresh.messagesTail(bot.threadId, 10)).toMatchObject({ hasMore: false });
      read.mockClear();
      expect(fresh.messagesFor(bot.threadId)).toHaveLength(1);
      expect(read).not.toHaveBeenCalled();

      const zeroPage = new Store(selection);
      expect(zeroPage.messagesTail(bot.threadId, 0)).toMatchObject({ messages: [], hasMore: true });
      expect(zeroPage.messagesFor(bot.threadId)[0]?.text).toBe("keep this");
    } finally {
      read.mockRestore();
    }
  });

  it("dismisses an open options card when the user talks, and leaves live asks", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Quick question", subtitle: "", options: ["A", "B"] },
    });
    expect(quiz.card?.dismissed).toBeUndefined();

    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const ask = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "later" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === ask.id)?.card?.dismissed).toBeUndefined();
  });

  it("persists a structured question card with its origin and answer across restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const secret = "sk-ant-" + "b".repeat(90);
    const ask = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: `Ship the release using ${secret}?`,
        options: ["Ship now", "Wait"],
        requestId: "req-q",
        questionRequest: {
          version: 1,
          origin: "output",
          questions: [{
            question: `Ship the release using ${secret}?`,
            header: "Release",
            options: [{ label: "Ship now", description: `uses ${secret}` }],
          }],
        },
      },
    });
    store.patchMessage(bot.threadId, ask.id, {
      card: {
        ...ask.card!,
        answered: "answer",
        answeredText: "The user answered your questions.\n\nQ: Ship the release?\nA: Ship now",
      },
    });

    const reloaded = new Store(selection);
    const restored = reloaded.messagesFor(bot.threadId).find((m) => m.id === ask.id)?.card;
    expect(restored?.requestId).toBe("req-q");
    expect(restored?.questionRequest?.origin).toBe("output");
    expect(restored?.questionRequest?.questions[0]?.header).toBe("Release");
    expect(restored?.answeredText).toContain("A: Ship now");
    expect(JSON.stringify(restored)).not.toContain(secret);
  });

  it("does not dismiss an open options card for bot-authored messages", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Quick question", subtitle: "", options: ["A", "B"] },
    });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "still here" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBeUndefined();
  });

  it("marks only the last assistant message from a settled provider turn as terminal", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const progress = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Checking connected apps.",
      turnId: "turn-1",
    });
    const final = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Here are your tasks.",
      turnId: "turn-1",
    });

    expect(store.markTerminalAssistantMessage(bot.threadId, "turn-1")?.id).toBe(final.id);
    expect(store.messagesFor(bot.threadId).find((message) => message.id === progress.id)?.turnTerminal).toBeUndefined();
    expect(store.messagesFor(bot.threadId).find((message) => message.id === final.id)?.turnTerminal).toBe(true);
    expect(new Store(selection).messagesFor(bot.threadId).find((message) => message.id === final.id)?.turnTerminal).toBe(true);
  });

  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("persists request provenance, failure and cancellation without altering message identity", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const source = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Fixture request", sendId: "fixture-send-id-1234" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Earlier handoff", turnId: "initial-turn",
      requestMessageId: source.id, turnTerminal: true, turnSucceeded: true });
    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", turnSucceeded: false, tool: { name: "error: fixture continuation failed", ok: false } });
    store.patchMessage(bot.threadId, source.id, { requestCancelled: true, requestPending: true });
    const saved = new Store(selection).messagesFor(bot.threadId);
    expect(saved[0]).toMatchObject({ id: source.id, sendId: source.sendId, requestCancelled: true, requestPending: true });
    expect(saved[1]).toMatchObject({ id: reply.id, requestMessageId: source.id, turnSucceeded: true });
    expect(saved[2].turnSucceeded).toBe(false);
  });

  it("creates explicitly scoped tasks atomically without inheriting remembered grants or changing siblings", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { approvalMode: "full", autoApprove: false, alwaysAllow: ["old-tool"] });
    const old = store.activeTask(bot.id)!;
    const before = structuredClone(old);
    const save = vi.spyOn(store as unknown as { saveBots(): void }, "saveBots");
    const ask = store.createTask(bot.id, "Explicit Ask", true, undefined, undefined, "ask")!;
    expect(save).toHaveBeenCalledTimes(1);
    expect(ask).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    const full = store.createTask(bot.id, "Authorized Full", true, undefined, undefined, "full")!;
    expect(full).toMatchObject({ approvalMode: "full", autoApprove: false, alwaysAllow: [] });
    expect(old).toEqual(before);
    expect(bot).toMatchObject({ approvalMode: "full", autoApprove: false, alwaysAllow: ["old-tool"] });
  });

  it("addTaskUsage accumulates settled-turn totals per task and survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 1200, output: 300, cachedInput: 1000, costUsd: null })).toMatchObject({
      input: 1200,
      output: 300,
      cachedInput: 1000,
      costUsd: null,
      turns: 1,
    });
    store.addTaskUsage(bot.id, bot.threadId, { input: 800, output: 100, costUsd: null });
    store.addTaskUsage(bot.id, bot.threadId, { input: Number.NaN, output: -20, cachedInput: -5, costUsd: null });
    // Providers occasionally report a cache count larger than input.
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 0, cachedInput: 20, costUsd: null });
    expect(store.addTaskUsage(bot.id, "no-such-thread", { input: 5, output: 5, costUsd: null })).toBeNull();

    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.usage).toMatchObject({
      input: 2010,
      output: 400,
      cachedInput: 1010,
      costUsd: null,
      turns: 4,
    });
    const withContext = store.addTaskUsage(bot.id, bot.threadId, { input: 300, output: 40, cachedInput: 250, costUsd: null, context: { tokens: 142_000, window: 272_000 } });
    expect(withContext).toMatchObject({ lastTurn: { input: 300, output: 40, cachedInput: 250, costUsd: null }, context: { tokens: 142_000, window: 272_000 } });
    const kept = store.addTaskUsage(bot.id, bot.threadId, { input: 5, output: 1, costUsd: null, context: { tokens: 0 } });
    expect(kept).toMatchObject({ lastTurn: { input: 5, output: 1, costUsd: null }, context: { tokens: 142_000, window: 272_000 } });
    expect(kept?.lastTurn).not.toHaveProperty("cachedInput");
  });

  it("chain-inserts a late turn artifact after its anchor without stealing the leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const turnEnd = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done with the task" });
    const followUp = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "next question" });
    const patches: string[] = [];
    store.onChange((change) => {
      if (change.type === "message.patch") patches.push(change.message.id);
    });

    const artifact = store.insertMessageAfter(bot.threadId, turnEnd.id, { role: "bot", kind: "screen", png: "abc" });

    const path = store.activePath(bot.threadId).map((m) => m.id);
    expect(path.slice(-3)).toEqual([turnEnd.id, artifact.id, followUp.id]);
    expect(store.activePath(bot.threadId).at(-1)?.id).toBe(followUp.id);
    expect(artifact.parentId).toBe(turnEnd.id);
    expect(patches).toContain(followUp.id);
    expect(new Store(selection).messagesTail(bot.threadId, 2).activeLeafId).toBe(followUp.id);
    expect(new Store(selection).activePath(bot.threadId).map((m) => m.id)).toEqual(path);
  });

  it("insertMessageAfter is a plain append when the anchor is still the leaf, or unknown", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const turnEnd = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done" });
    const artifact = store.insertMessageAfter(bot.threadId, turnEnd.id, { role: "bot", kind: "screen", png: "abc" });
    expect(store.activePath(bot.threadId).at(-1)?.id).toBe(artifact.id);
    expect(new Store(selection).activePath(bot.threadId).at(-1)?.id).toBe(artifact.id);

    const orphan = store.insertMessageAfter(bot.threadId, "no-such-message", { role: "bot", kind: "text", text: "x" });
    expect(store.activePath(bot.threadId).at(-1)?.id).toBe(orphan.id);
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("persists per-bot connector tool grants without touching legacy records", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const legacy = store.createBot();
    store.patchBot(bot.id, {
      connectorTools: {
        gmail: { tools: ["GMAIL_SEND_EMAIL", "GMAIL_GET_MESSAGE", "GMAIL_SEND_EMAIL"] },
        github: { tools: "*" },
      },
    });
    expect(store.bot(bot.id)?.connectorTools).toEqual({
      gmail: { tools: ["GMAIL_SEND_EMAIL", "GMAIL_GET_MESSAGE"] },
      github: { tools: "*" },
    });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.connectorTools).toEqual(store.bot(bot.id)?.connectorTools);
    expect(reloaded.bot(legacy.id)?.connectorTools).toBeUndefined();
    expect(reloaded.bot(legacy.id)?.composio).toBeUndefined();
  });

  it("rejects malformed connector tool grants at the store boundary", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const malformed: unknown[] = [
      "nope",
      ["gmail"],
      { Gmail: { tools: "*" } },
      { "bad slug!": { tools: "*" } },
      { gmail: { tools: [] } },
      { gmail: { tools: ["gmail_send_email"] } },
      { gmail: { tools: ["GMAIL_SEND_EMAIL", 7] } },
      { gmail: { tools: "*", accountId: "private" } },
      { gmail: { tools: "GMAIL_SEND_EMAIL" } },
      { gmail: "*" },
    ];
    for (const value of malformed) {
      expect(() => store.patchBot(bot.id, { connectorTools: value as never })).toThrow(/connectorTools/);
    }
    expect(store.bot(bot.id)?.connectorTools).toBeUndefined();
    store.patchBot(bot.id, { connectorTools: {} });
    expect(store.bot(bot.id)?.connectorTools).toEqual({});
    store.patchBot(bot.id, { connectorTools: undefined });
    expect(store.bot(bot.id)?.connectorTools).toBeUndefined();
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("defaults a room to its first member and repairs the lead when membership changes", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Team", [first.id, second.id]);

    expect(group.defaultResponder).toEqual({ kind: "member", botId: first.id });
    store.patchGroup(group.id, { memberIds: [second.id] });
    expect(group.defaultResponder).toEqual({ kind: "member", botId: second.id });

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
  });

  it("persists a channel's context when it is created", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Website launch", [bot.id], false, "Work");

    expect(channel.section).toBe("Work");
    expect(new Store(selection).group(channel.id)?.section).toBe("Work");
  });

  it("persists a channel's completed setup in the same create write", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Launch", [bot.id], false, "Work", {
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      completed: true,
    });

    expect(channel).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupSkippedAt: null,
    });
    expect(channel.setupCompletedAt).toEqual(expect.any(Number));
    expect(new Store(selection).group(channel.id)).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupCompletedAt: channel.setupCompletedAt,
    });
  });

  it("migrates old rooms without routing to their first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Legacy team", [first.id, second.id]);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    delete saved[0].defaultResponder;
    writeFileSync(groupsFile, JSON.stringify(saved));

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("revokes an unconfirmed elevated approval grant before startup work", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, {
      approvalMode: "full",
      approvalGrant: {
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        mode: "full",
        phase: "confirmed",
      },
    });

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({
      approvalMode: "ask",
      autoApprove: false,
    });
    expect(reloaded.bot(bot.id)).not.toHaveProperty("approvalGrant");

    const persisted: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((candidate) => candidate.id === bot.id)).toMatchObject({
      approvalMode: "ask",
      autoApprove: false,
    });
    expect(persisted.find((candidate) => candidate.id === bot.id)).not.toHaveProperty("approvalGrant");
  });

  it.each(["prepared", "confirmed", "activated", "committed"] as const)("revokes a thread-scoped grant after restart in phase %s", (phase) => {
    const store = new Store(selection);
    const bot = store.createBot();
    const target = store.createTask(bot.id, "Target")!;
    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: {
      requestId: "123e4567-e89b-42d3-a456-426614174000", mode: "full", phase, threadId: target.threadId,
    } });
    store.patchTask(bot.id, target.threadId, { approvalMode: "full" });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.approvalMode).toBe("ask");
    expect(reloaded.bot(bot.id)?.approvalGrant).toBeUndefined();
    expect(reloaded.projectBotForTask(bot.id, target.threadId)?.approvalMode).toBe("ask");
  });

  it.each(["prepared", "confirmed", "activated", "committed"] as const)("recovers a composer-only grant in phase %s without downgrading other threads", (phase) => {
    const store = new Store(selection);
    const bot = store.createBot();
    const target = store.createTask(bot.id, "Target")!;
    const sibling = store.createTask(bot.id, "Other work")!;
    store.patchBot(bot.id, { approvalMode: "full", approvalGrant: {
      requestId: "123e4567-e89b-42d3-a456-426614174000", mode: "custom", phase, threadId: target.threadId, threadOnly: true,
    } });
    store.patchTask(bot.id, target.threadId, { approvalMode: "custom" });
    store.patchTask(bot.id, sibling.threadId, { approvalMode: "full" });
    expect(store.projectBotForTask(bot.id, sibling.threadId)?.approvalGrant).toBeUndefined();
    expect(store.projectBotForTask(bot.id, target.threadId)?.approvalGrant?.phase).toBe(phase);
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.approvalMode).toBe("full");
    expect(reloaded.bot(bot.id)?.approvalGrant).toBeUndefined();
    expect(reloaded.projectBotForTask(bot.id, target.threadId)?.approvalMode).toBe("ask");
    expect(reloaded.projectBotForTask(bot.id, sibling.threadId)?.approvalMode).toBe("full");
  });

  it("normalizes persisted cloud backends without changing valid or absent values", () => {
    const store = new Store(selection);
    const boat = store.createBot();
    const vps = store.createBot();
    const invalid = store.createBot();
    const absent = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((bot) => bot.id === boat.id)!.cloudBackend = "box";
    raw.find((bot) => bot.id === vps.id)!.cloudBackend = "vps";
    (raw.find((bot) => bot.id === invalid.id) as unknown as { cloudBackend: string }).cloudBackend = "daytona";
    delete raw.find((bot) => bot.id === absent.id)!.cloudBackend;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(boat.id)?.cloudBackend).toBe("box");
    expect(reloaded.bot(vps.id)?.cloudBackend).toBe("vps");
    expect(reloaded.bot(invalid.id)?.cloudBackend).toBeUndefined();
    expect(reloaded.bot(absent.id)?.cloudBackend).toBeUndefined();

    const saved: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(saved.find((bot) => bot.id === boat.id)?.cloudBackend).toBe("box");
    expect(saved.find((bot) => bot.id === vps.id)?.cloudBackend).toBe("vps");
    expect(saved.find((bot) => bot.id === invalid.id)).not.toHaveProperty("cloudBackend");
    expect(saved.find((bot) => bot.id === absent.id)).not.toHaveProperty("cloudBackend");
  });

  it("migrates legacy browser profile references without collapsing case-distinct accounts", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const duplicate = store.createBot();
    const caseVariant = store.createBot();
    const configFile = join(DATA_DIR, "config.json");
    const botsFile = join(DATA_DIR, "bots.json");
    writeFileSync(configFile, JSON.stringify({
      browserProfiles: [
        { id: "Work", name: "Primary" },
        { id: "Work", name: "Duplicate" },
        { id: "work", name: "Lowercase variant" },
      ],
    }));
    const bots: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    bots.find((bot) => bot.id === first.id)!.browserProfile = "Work";
    bots.find((bot) => bot.id === duplicate.id)!.browserProfile = "Work";
    bots.find((bot) => bot.id === caseVariant.id)!.browserProfile = "work";
    writeFileSync(botsFile, JSON.stringify(bots));

    const reloaded = new Store(selection);
    expect(reloaded.bot(first.id)?.browserProfile).toBe("work-2");
    expect(reloaded.bot(duplicate.id)?.browserProfile).toBe("work-2");
    expect(reloaded.bot(caseVariant.id)?.browserProfile).toBe("work");

    const persisted: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    expect(persisted.find((bot) => bot.id === first.id)?.browserProfile).toBe("work-2");
    expect(persisted.find((bot) => bot.id === duplicate.id)?.browserProfile).toBe("work-2");
    expect(persisted.find((bot) => bot.id === caseVariant.id)?.browserProfile).toBe("work");

    const reloadedAgain = new Store(selection);
    expect(reloadedAgain.bot(first.id)?.browserProfile).toBe("work-2");
    expect(reloadedAgain.bot(duplicate.id)?.browserProfile).toBe("work-2");
    expect(reloadedAgain.bot(caseVariant.id)?.browserProfile).toBe("work");
  });

  it("keeps explicit suffix browser references stable across legacy migration", () => {
    const store = new Store(selection);
    const upper = store.createBot();
    const canonical = store.createBot();
    const suffixed = store.createBot();
    const configFile = join(DATA_DIR, "config.json");
    const botsFile = join(DATA_DIR, "bots.json");
    writeFileSync(configFile, JSON.stringify({
      browserProfiles: [
        { id: "Work", name: "Uppercase" },
        { id: "work", name: "Canonical" },
        { id: "work-2", name: "Explicit suffix" },
      ],
    }));
    const bots: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    bots.find((bot) => bot.id === upper.id)!.browserProfile = "Work";
    bots.find((bot) => bot.id === canonical.id)!.browserProfile = "work";
    bots.find((bot) => bot.id === suffixed.id)!.browserProfile = "work-2";
    writeFileSync(botsFile, JSON.stringify(bots));

    const reloaded = new Store(selection);
    expect(reloaded.bot(upper.id)?.browserProfile).toBe("work-3");
    expect(reloaded.bot(canonical.id)?.browserProfile).toBe("work");
    expect(reloaded.bot(suffixed.id)?.browserProfile).toBe("work-2");

    const persisted: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    expect(persisted.find((bot) => bot.id === upper.id)?.browserProfile).toBe("work-3");
    expect(persisted.find((bot) => bot.id === canonical.id)?.browserProfile).toBe("work");
    expect(persisted.find((bot) => bot.id === suffixed.id)?.browserProfile).toBe("work-2");

    const reloadedAgain = new Store(selection);
    expect(reloadedAgain.bot(upper.id)?.browserProfile).toBe("work-3");
    expect(reloadedAgain.bot(canonical.id)?.browserProfile).toBe("work");
    expect(reloadedAgain.bot(suffixed.id)?.browserProfile).toBe("work-2");
  });

  it("migrates unambiguous legacy peer grants without guessing duplicate names", () => {
    const store = new Store(selection);
    const requester = store.createBot();
    const helper = store.patchBot(store.createBot().id, { name: "Helper" })!;
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(requester.id, {
      alwaysAllow: ["ask_bot:@Helper", "delegate_bot:@Twin", "Bash:git status"],
    });

    const reloaded = new Store(selection);
    expect(reloaded.bot(requester.id)?.alwaysAllow).toEqual([
      peerAllowKey("ask_bot", helper.id),
      "delegate_bot:@Twin",
      "Bash:git status",
    ]);

    const persisted: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((bot) => bot.id === requester.id)?.alwaysAllow).toEqual(
      reloaded.bot(requester.id)?.alwaysAllow,
    );
  });

  it("promotes task-only provider tool grants to the bot default", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.activeTask(bot.id)!;
    const second = store.createTask(bot.id)!;
    store.patchTask(bot.id, first.threadId, {
      alwaysAllow: ["provider-tool:claude:linear:list_issues:config-one", "Bash:git status"],
    });
    store.patchTask(bot.id, second.threadId, {
      alwaysAllow: ["provider-tool:claude:linear:list_comments:config-one"],
    });

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.alwaysAllow).toEqual([
      "provider-tool:claude:linear:list_comments:config-one",
      "provider-tool:claude:linear:list_issues:config-one",
    ]);
    expect(reloaded.createTask(bot.id)?.alwaysAllow).toEqual([
      "provider-tool:claude:linear:list_comments:config-one",
      "provider-tool:claude:linear:list_issues:config-one",
    ]);

    const persisted: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((candidate) => candidate.id === bot.id)?.alwaysAllow).toEqual(
      reloaded.bot(bot.id)?.alwaysAllow,
    );
  });

  it("persists a bot's effort level across a restart, defaulting to unset", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.modelSelection.effort).toBeUndefined();

    store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, effort: "high" } });

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.modelSelection.effort).toBe("high");
  });

  it("completes every new bot's selection with the workspace defaults, whichever path creates it", () => {
    const store = new Store(selection, (chosen) => ({ ...chosen, effort: "medium" }));
    const defaulted = store.createBot();
    const explicit = store.createBot({ modelSelection: { instanceId: "codex", model: "chosen" } });
    const chief = store.createBot({ name: "Chief", section: "Ops" });
    store.patchBot(chief.id, { chiefOfStaff: true });
    store.applyTeamSetup({ version: 1, requestId: "setup-effort", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "create", botId: "set-up", threadId: "set-up-thread", fields: { name: "Analyst", section: "Ops", modelSelection: selection() } },
      ] });
    expect(explicit.modelSelection).toEqual({ instanceId: "codex", model: "chosen", effort: "medium" });
    for (const bot of [defaulted, explicit, new Store(selection).bot("set-up")!]) {
      expect(bot.modelSelection.effort).toBe("medium");
      expect(bot.tasks?.[0].modelSelection).toBeUndefined();
    }
  });

  it("lands a created specialist in its proposed working folder, keeping the private workspace clean", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Ops" });
    store.patchBot(chief.id, { chiefOfStaff: true });
    const folder = mkdtempSync(join(tmpdir(), "omb-store-cwd-"));
    store.applyTeamSetup({ version: 1, requestId: "setup-cwd", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "create", botId: "cwd-bot", threadId: "cwd-thread", fields: { name: "Foldered", section: "Ops", modelSelection: selection(), cwd: folder } },
        { action: "create", botId: "plain-bot", threadId: "plain-thread", fields: { name: "Plain", section: "Ops", modelSelection: selection(), cwd: "" } },
      ] });
    expect(store.bot("cwd-bot")?.cwd).toBe(folder);
    expect("cwd" in (store.bot("plain-bot") ?? {})).toBe(false);
  });

  it("stores variants independently; conversations without one of their own follow the bot", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id, "Second")!;
    const chosen = { instanceId: "opencodeGo", model: "provider/model", variant: "low" };
    store.switchTaskModel(bot.id, first, chosen, false, false);
    expect(store.projectBotForTask(bot.id, second.threadId)!.modelSelection).toEqual(selection());
    store.patchBot(bot.id, { modelSelection: { ...chosen, variant: "minimal" } });
    const future = store.createTask(bot.id, "Future")!;
    const reloaded = new Store(selection);
    expect(reloaded.projectBotForTask(bot.id, first)!.modelSelection).toEqual(chosen);
    expect(reloaded.projectBotForTask(bot.id, second.threadId)!.modelSelection).toEqual({ ...chosen, variant: "minimal" });
    expect(reloaded.projectBotForTask(bot.id, future.threadId)!.modelSelection).toEqual({ ...chosen, variant: "minimal" });
  });

  it("starts a task on a model it is handed, as its own copy, without moving the bot default", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const parent = { instanceId: "opencodeGo", model: "provider/model", variant: "low" };
    const handed = structuredClone(parent);
    const child = store.createTask(bot.id, "Child", false, undefined, undefined, undefined, handed)!;
    handed.model = "provider/changed-later";
    const fresh = store.createTask(bot.id, "Fresh", false)!;
    const reloaded = new Store(selection);
    expect(reloaded.projectBotForTask(bot.id, child.threadId)!.modelSelection).toEqual(parent);
    expect(reloaded.projectBotForTask(bot.id, fresh.threadId)!.modelSelection).toEqual(selection());
    expect(reloaded.bot(bot.id)!.modelSelection).toEqual(selection());
  });

  it("applies one reviewed default-model change with applyTeamSetup's task stamping", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id, "Second")!;
    const pinned = { instanceId: "claude", model: "claude-opus-4-5" };
    store.switchTaskModel(bot.id, first, pinned, false, false);
    const next = { instanceId: "codex", model: "gpt-5-codex" };
    expect(store.applyModelDefault(bot.id, next)?.modelSelection).toEqual(next);
    expect(store.projectBotForTask(bot.id, first)!.modelSelection).toEqual(pinned);
    expect(store.projectBotForTask(bot.id, second.threadId)!.modelSelection).toEqual(next);
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)!.modelSelection).toEqual(next);
    expect(reloaded.projectBotForTask(bot.id, first)!.modelSelection).toEqual(pinned);
    expect(reloaded.projectBotForTask(bot.id, second.threadId)!.modelSelection).toEqual(next);
  });

  it("keeps one persisted Chief of Staff per section and supports handoff", () => {
    const store = new Store(selection);
    const first = store.createBot({ section: "Work" });
    const second = store.createBot({ section: "Work" });
    const personal = store.createBot({ section: "Personal" });

    expect(store.setChiefOfStaff(first.id)?.map((bot) => bot.id)).toEqual([first.id]);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(true);
    expect(store.setChiefOfStaff(personal.id)?.map((bot) => bot.id)).toEqual([personal.id]);

    const changed = store.setChiefOfStaff(second.id)!;
    expect(changed.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(personal.id)?.chiefOfStaff).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id).sort()).toEqual(
      [second.id, personal.id].sort(),
    );
    expect(reloaded.setChiefOfStaff(null, "Work")?.map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.bot(personal.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(second.id)?.chiefOfStaff).toBe(false);
  });

  it("adds and removes members together without replacing unrelated concurrent additions", () => {
    const store = new Store(selection);
    const outgoing = store.createBot({ section: "Delivery" });
    const incoming = store.createBot({ section: "Research" });
    const concurrent = store.createBot({ section: "Delivery" });
    const archived = store.createBot({ section: "Delivery" });
    store.patchBot(archived.id, { hidden: true });
    const originalThread = outgoing.threadId;
    const result = store.updateTeamMembers("Delivery", [incoming.id], [outgoing.id]);
    expect(result.ok).toBe(true);
    expect(store.bot(outgoing.id)).toMatchObject({ threadId: originalThread, section: undefined });
    expect(store.bot(incoming.id)?.section).toBe("Delivery");
    expect(store.bot(concurrent.id)?.section).toBe("Delivery");
    expect(store.bot(archived.id)?.section).toBe("Delivery");
    const restored = new Store(selection);
    expect(restored.bot(outgoing.id)?.section).toBeUndefined();
    expect(restored.bot(incoming.id)?.section).toBe("Delivery");
    expect(restored.sections).toContain("Delivery");
  });

  it("rejects stale removals and Chief conflicts without applying the additions", () => {
    const store = new Store(selection);
    const chief = store.createBot({ section: "Delivery" });
    const generalChief = store.createBot();
    const incoming = store.createBot({ section: "Research" });
    store.setChiefOfStaff(chief.id);
    store.setChiefOfStaff(generalChief.id);
    expect(store.updateTeamMembers("Delivery", [incoming.id], [chief.id])).toEqual({ ok: false, reason: "chief-conflict" });
    expect(store.bot(incoming.id)?.section).toBe("Research");
    expect(store.updateTeamMembers("Delivery", [], [incoming.id])).toEqual({ ok: false, reason: "membership-changed" });
    expect(store.updateTeamMembers("Delivery", ["missing"], [])).toEqual({ ok: false, reason: "unavailable" });
    expect(store.updateTeamMembers("Delivery", [chief.id], [chief.id])).toEqual({ ok: false, reason: "membership-changed" });
    store.setChiefOfStaff(null, "");
    expect(store.updateTeamMembers("Delivery", [incoming.id], [chief.id]).ok).toBe(true);
    expect(store.bot(chief.id)).toMatchObject({ section: undefined, chiefOfStaff: true });
  });

  it("keeps membership unchanged if the shared write fails", () => {
    const store = new Store(selection);
    const outgoing = store.createBot({ section: "Delivery" });
    const incoming = store.createBot({ section: "Research" });
    const write = vi.spyOn(store as any, "saveBots").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => store.updateTeamMembers("Delivery", [incoming.id], [outgoing.id])).toThrow("disk unavailable");
    write.mockRestore();
    expect(store.bot(outgoing.id)?.section).toBe("Delivery");
    expect(store.bot(incoming.id)?.section).toBe("Research");
    expect(new Store(selection).bot(outgoing.id)?.section).toBe("Delivery");
  });

  it("files visible bots atomically without changing Chief roles", () => {
    const store = new Store(selection);
    const incumbent = store.createBot({ section: "Launch" });
    const incoming = store.createBot({ section: "Research" });
    const teammate = store.createBot({ section: "Personal" });
    store.setChiefOfStaff(incumbent.id);

    const result = store.setBotsSection([incoming.id, teammate.id, incoming.id], "Launch");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected section assignment failure: ${result.reason}`);
    expect(result.bots.map((bot) => bot.id)).toEqual([incoming.id, teammate.id]);
    expect(store.bot(incumbent.id)).toMatchObject({ section: "Launch", chiefOfStaff: true });
    expect(store.bot(incoming.id)?.section).toBe("Launch");
    expect(Boolean(store.bot(incoming.id)?.chiefOfStaff)).toBe(false);
    expect(store.bot(teammate.id)?.section).toBe("Launch");
    expect(store.bots.filter((bot) => bot.section === "Launch" && bot.chiefOfStaff)).toHaveLength(1);

    const reloaded = new Store(selection);
    expect(reloaded.bot(incumbent.id)).toMatchObject({ section: "Launch", chiefOfStaff: true });
    expect(reloaded.bot(incoming.id)?.section).toBe("Launch");
    expect(Boolean(reloaded.bot(incoming.id)?.chiefOfStaff)).toBe(false);
    expect(reloaded.bot(teammate.id)?.section).toBe("Launch");
    expect(reloaded.bots.filter((bot) => bot.section === "Launch" && bot.chiefOfStaff).map((bot) => bot.id))
      .toEqual([incumbent.id]);
  });

  it.each([null, "Renamed"])("revokes exact old team grants before changing the empty team to %s", (nextName) => {
    const store = new Store(selection);
    const chief = store.createBot({ section: "Office" });
    store.setChiefOfStaff(chief.id);
    store.setBotsSection([], "Delivery");
    store.setBotsSection([], "Delivery East");
    store.patchBot(chief.id, { managedSections: ["Delivery", " Delivery ", "Delivery East", ""] });
    const announcements: string[] = [];
    store.onChange(change => { if (change.type === "bot") announcements.push(change.botId); });

    expect(store.changeEmptySection("Delivery", nextName)).toBeUndefined();
    expect(chief.managedSections).toEqual(["Delivery East", ""]);
    expect(canAccessTeam(chief, "Delivery")).toBe(false);
    expect(announcements).toEqual([chief.id]);
    store.setBotsSection([], "Delivery");
    const reloaded = new Store(selection);
    expect(reloaded.sections).toContain("Delivery");
    expect(canAccessTeam(reloaded.bot(chief.id)!, "Delivery")).toBe(false);
    expect(canAccessTeam(reloaded.bot(chief.id)!, "Delivery East")).toBe(true);
    expect(canAccessTeam(reloaded.bot(chief.id)!, "")).toBe(true);
  });

  it("keeps grants when an empty-team rename is a no-op or rejected", () => {
    const store = new Store(selection);
    const chief = store.createBot({ section: "Office" });
    store.setChiefOfStaff(chief.id);
    for (const name of ["Delivery", "Existing"]) store.setBotsSection([], name);
    store.patchBot(chief.id, { managedSections: ["Delivery"] });
    const changes: string[] = [];
    store.onChange(change => { changes.push(change.type); });
    expect(store.changeEmptySection("Delivery", "Delivery")).toBeUndefined();
    expect(store.changeEmptySection("Delivery", "Existing")).toContain("already exists");
    expect(changes).toEqual([]);
    expect(chief.managedSections).toEqual(["Delivery"]);
    expect(new Store(selection).bot(chief.id)?.managedSections).toEqual(["Delivery"]);
  });

  it("does not free a team name when its grant revocation cannot persist", () => {
    const store = new Store(selection);
    const chief = store.createBot({ section: "Office" });
    store.setChiefOfStaff(chief.id);
    store.setBotsSection([], "Delivery");
    store.patchBot(chief.id, { managedSections: ["Delivery"] });
    (store as unknown as { saveBots: () => void }).saveBots = () => { throw new Error("disk unavailable"); };
    expect(() => store.changeEmptySection("Delivery", null)).toThrow("disk unavailable");
    expect(store.sections).toContain("Delivery");
    expect(chief.managedSections).toEqual(["Delivery"]);
    expect(new Store(selection).sections).toContain("Delivery");
  });

  it("rejects unavailable or Chief-conflicting section assignments without changing bots", () => {
    const store = new Store(selection);
    const incumbent = store.createBot({ section: "Launch" });
    const incoming = store.createBot({ section: "Research" });
    const teammate = store.createBot({ section: "Personal" });
    const hidden = store.createBot({ section: "Private" });
    store.setChiefOfStaff(incumbent.id);
    store.setChiefOfStaff(incoming.id);
    store.patchBot(hidden.id, { hidden: true });

    const snapshot = () => store.bots.map((bot) => ({
      id: bot.id,
      section: bot.section,
      chief: bot.chiefOfStaff,
    }));
    const before = snapshot();

    expect(store.setBotsSection([teammate.id, "missing"], "Launch"))
      .toEqual({ ok: false, reason: "unavailable" });
    expect(store.setBotsSection([teammate.id, hidden.id], "Launch"))
      .toEqual({ ok: false, reason: "unavailable" });
    expect(store.setBotsSection([incoming.id, teammate.id], "Launch"))
      .toEqual({ ok: false, reason: "chief-conflict" });
    expect(snapshot()).toEqual(before);

    const reloaded = new Store(selection);
    expect(reloaded.bot(incumbent.id)).toMatchObject({ section: "Launch", chiefOfStaff: true });
    expect(reloaded.bot(incoming.id)).toMatchObject({ section: "Research", chiefOfStaff: true });
    expect(reloaded.bot(teammate.id)?.section).toBe("Personal");
    expect(Boolean(reloaded.bot(teammate.id)?.chiefOfStaff)).toBe(false);
  });

  it("does not change memory or emit section updates when the atomic write fails", () => {
    const store = new Store(selection);
    const bot = store.createBot({ section: "Original" });
    const changes: string[] = [];
    store.onChange((change) => {
      if (change.type === "bot") changes.push(change.botId);
    });
    (store as unknown as { saveBots: (bots?: BotRecord[]) => void }).saveBots = () => {
      throw new Error("disk unavailable");
    };

    expect(() => store.setBotsSection([bot.id], "Research")).toThrow("disk unavailable");
    expect(store.bot(bot.id)?.section).toBe("Original");
    expect(changes).toEqual([]);
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Quick question", subtitle: "", options: ["A", "B"] },
    });

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });

  it("keeps memory and SQLite pending when a card patch cannot persist", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Quick question", subtitle: "", options: ["A", "B"] },
    });
    const update = vi.spyOn(mdb, "updateMessage").mockImplementationOnce(() => {
      throw new Error("simulated SQLite failure");
    });
    expect(() => store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "allow" },
    })).toThrow("simulated SQLite failure");
    update.mockRestore();

    expect(store.messagesFor(bot.threadId).find((message) => message.id === card.id)?.card?.answered).toBeUndefined();
    expect(new Store(selection).messagesFor(bot.threadId).find((message) => message.id === card.id)?.card?.answered).toBeUndefined();
  });

  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("seedIfEmpty starts a fresh workspace with one bot, the Chief of Staff, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
    expect(store.bots[0], "the first bot a new person meets is their Chief of Staff").toMatchObject({ chiefOfStaff: true, hidden: false });
    expect(store.bots[0], "the role is the flag, so an untouched starter still reads as unused when sending to the Cloud")
      .toMatchObject({ title: "", description: "", soul: "" });
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);

    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(1);
    expect(reloaded.bots[0]?.chiefOfStaff).toBe(true);
  });

  it("seedIfEmpty makes the new install's Chief its MausBot in chrome, introduced, and no bot after it takes chrome or silver in turn", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    const chief = store.bots[0]!;
    expect(chief).toMatchObject({ name: "MausBot", color: "chrome", chiefOfStaff: true, defaultBot: {} });
    expect(store.messagesFor(chief.threadId).map((message) => [message.kind, message.helperIntro, message.card?.options.length])).toEqual([["options", true, 4]]);
    expect(store.messagesFor(chief.threadId)[0]!.text).toContain("Hi, I'm MausBot, your helper for everything here.");
    const later = Array.from({ length: 25 }, () => store.createBot());
    expect(later.map((bot) => bot.color)).not.toContain("silver");
    expect(later.map((bot) => bot.color)).not.toContain("chrome");
    expect(later[0]?.color).toBe("blue");
    expect(later.map((bot) => bot.name)).not.toContain("MausBot");
    expect(new Store(selection).bot(chief.id)).toMatchObject({ name: "MausBot", color: "chrome", defaultBot: {} });
  });

  it("seedIfEmpty leaves an existing workspace without a Chief as it is", () => {
    const store = new Store(selection);
    const existing = store.createBot();
    store.seedIfEmpty();
    expect(store.bots.map((bot) => bot.id)).toEqual([existing.id]);
    expect(new Store(selection).bot(existing.id)?.chiefOfStaff).toBeFalsy();
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[0].id);
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    const events: Array<Record<string, unknown>> = [];
    store.onChange((e) => events.push(e as unknown as Record<string, unknown>));

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId);
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(events.filter((e) => e.type === "message" || e.type === "thread")).toEqual([
      { type: "message", threadId: bot.threadId, message: edited },
      { type: "thread", threadId: bot.threadId, activeLeafId: edited.id },
    ]);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("branchMessage tells clients to show the fork, keeping the edit's sendId", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    const changes: Array<{ type: string; activeLeafId?: string; messageId?: string }> = [];
    store.onChange((change) => {
      if (change.type === "message") changes.push({ type: "message", messageId: change.message.id });
      if (change.type === "thread") changes.push({ type: "thread", activeLeafId: change.activeLeafId });
    });

    const edited = store.branchMessage(bot.threadId, original.id, "v2", "edit-send-id", undefined, { cardId: "c_1", draftSql: "select 1" })!;
    expect(edited.sendId).toBe("edit-send-id");
    expect(edited.dataContext).toEqual({ cardId: "c_1", draftSql: "select 1" });
    expect(edited.text).toBe("v2");
    expect(changes).toEqual([
      { type: "message", messageId: edited.id },
      { type: "thread", activeLeafId: edited.id },
    ]);
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });

  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("deleteBot removes the bot and its durable transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const skillState = join(DATA_DIR, "skill-state", bot.id);
    mkdirSync(skillState, { recursive: true });
    writeFileSync(join(skillState, "staged.json"), '{"writes":{}}');
    expect(new Store(selection).messagesFor(bot.threadId).length).toBeGreaterThan(0);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(new Store(selection).messagesFor(bot.threadId)).toHaveLength(0);
    expect(existsSync(skillState)).toBe(false);
    expect(store.deleteBot(bot.id)).toBe(false);
  });
  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    // seedMessages:false: a legacy thread's history is only in the JSON file, and any DB rows would take precedence.
    const bot = store.createBot({}, { seedMessages: false });
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("custom mascot profile persistence", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("saves, snapshots, resets and reloads custom choices with one canonical profile", () => {
    const store = new Store(selection);
    const source = store.createBot({ name: "Shape source" });
    const bot = store.createBot({ name: "Custom mascot owner", mascotBody: "star" });
    store.patchBotProfile(bot.id, { avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle" });
    const outline: CustomMascotPoint[] = Array.from({ length: 96 }, (_, index) => {
      const angle = (index / 96) * Math.PI * 2;
      return [FACE_BOX / 2 + Math.cos(angle) * 108, FACE_BOX / 2 + Math.sin(angle) * 108];
    });
    const anchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
    const shape = validateCustomMascotDefinition({ name: "Bunny", outline, anchor });
    store.addOrSelectMascotShape(source.id, shape);

    const save = vi.spyOn(store as unknown as { saveBots(): void }, "saveBots");
    const saved = store.addOrSelectMascotShape(bot.id, structuredClone(shape))!;
    expect(save).toHaveBeenCalledTimes(1);
    save.mockRestore();
    expect(saved).toMatchObject({ avatarUrl: undefined, avatarCrop: "mascot", mascotBody: "cursor" });
    expect(saved.mascotProfile).toMatchObject({ selected: { kind: "custom", shapeId: shape.id }, shapes: [shape] });
    expect(store.addOrSelectMascotShape(bot.id, structuredClone(shape))?.mascotProfile?.shapes).toHaveLength(1);

    store.patchBotProfile(bot.id, { mascotBody: "star" });
    expect(saved.mascotProfile).toMatchObject({ selected: { kind: "builtin", bodyId: "star" }, shapes: [shape] });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(disk[0]).toHaveProperty("mascotBody", "star");
    store.deleteBot(source.id);
    expect(new Store(selection).bot(bot.id)?.mascotProfile).toEqual(saved.mascotProfile);
  });

  it("migrates a legacy builtin body into the profile and preserves its explicit body", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Legacy body", mascotBody: "circle" });
    const bots = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<Record<string, unknown>>;
    delete bots[0]!.mascotProfile;
    bots[0]!.mascotBody = "circle";
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(bots));

    const restored = new Store(selection).bot(bot.id)!;
    expect(restored.mascotProfile).toMatchObject({ version: 1, selected: { kind: "builtin", bodyId: "circle" }, shapes: [] });
    const migrated = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(migrated[0]).toHaveProperty("mascotBody", "circle");
    expect(migrated[0]).toHaveProperty("mascotProfile");
    expect(existsSync(join(DATA_DIR, "mascot-profile-recovery"))).toBe(false);
  });

  it.each([
    ["malformed", { version: 1, shapes: [{ id: "broken", name: "Secret profile marker" }], selected: { kind: "custom", shapeId: "broken" } }],
    ["future-version", { version: 2, shapes: [], selected: { kind: "builtin", bodyId: "future-body" }, privateMarker: "Secret profile marker" }],
  ] as const)("preserves the original registry before normalizing a %s stored mascot profile", (_kind, invalidProfile) => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Invalid mascot profile" });
    const file = join(DATA_DIR, "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    bots.find((record) => record.id === bot.id)!.mascotProfile = invalidProfile;
    const original = Buffer.from(JSON.stringify(bots));
    writeFileSync(file, original);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const restored = new Store(selection).bot(bot.id)!;

    expect(restored.mascotProfile).toMatchObject({ version: 1, shapes: [], selected: { kind: "builtin", bodyId: "cursor" } });
    const persisted = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted.find((record) => record.id === bot.id)?.mascotProfile).toEqual(restored.mascotProfile);
    const recoveryDirectory = join(DATA_DIR, "mascot-profile-recovery");
    const [recoveryName] = readdirSync(recoveryDirectory);
    const recoveryFile = join(recoveryDirectory, recoveryName!);
    expect(recoveryName).toMatch(/^bots-mascot-profile-[a-f0-9]{64}\.json$/);
    expect(readFileSync(recoveryFile)).toEqual(original);
    if (process.platform !== "win32") {
      expect(lstatSync(recoveryDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(recoveryFile).mode & 0o777).toBe(0o600);
    }
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`bot ${bot.id}`));
    expect(warning.mock.calls.flat().join(" ")).toContain(recoveryFile);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("Secret profile marker");
    warning.mockRestore();
  });

  it("reuses the identical recovery copy on repeated startup", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Invalid mascot profile" });
    const file = join(DATA_DIR, "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    bots.find((record) => record.id === bot.id)!.mascotProfile = { version: 2, shapes: [], selected: { kind: "builtin", bodyId: "cursor" } };
    const original = Buffer.from(JSON.stringify(bots));
    writeFileSync(file, original);

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Store(selection);
    const recoveryDirectory = join(DATA_DIR, "mascot-profile-recovery");
    const [recoveryName] = readdirSync(recoveryDirectory);
    const recoveryFile = join(recoveryDirectory, recoveryName!);
    expect(readFileSync(recoveryFile)).toEqual(original);
    writeFileSync(file, original);
    new Store(selection);
    expect(readdirSync(recoveryDirectory)).toEqual([recoveryName]);
    expect(readFileSync(recoveryFile)).toEqual(original);
    expect(warning).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("does not overwrite a conflicting content-addressed recovery file", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Invalid mascot profile" });
    const file = join(DATA_DIR, "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    bots.find((record) => record.id === bot.id)!.mascotProfile = { version: 2, shapes: [], selected: { kind: "builtin", bodyId: "cursor" } };
    const original = Buffer.from(JSON.stringify(bots));
    writeFileSync(file, original);
    const recoveryDirectory = join(DATA_DIR, "mascot-profile-recovery");
    mkdirSync(recoveryDirectory, { recursive: true });
    const digest = createHash("sha256").update(original).digest("hex");
    const recoveryFile = join(recoveryDirectory, `bots-mascot-profile-${digest}.json`);
    const existing = Buffer.from("keep the pre-existing recovery file");
    writeFileSync(recoveryFile, existing);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => new Store(selection)).toThrow(/recovery file does not match/i);
    expect(readFileSync(file)).toEqual(original);
    expect(readFileSync(recoveryFile)).toEqual(existing);
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("does not rewrite bots.json or continue startup if recovery fails", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Invalid mascot profile" });
    const file = join(DATA_DIR, "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    bots.find((record) => record.id === bot.id)!.mascotProfile = { version: 2, shapes: [], selected: { kind: "builtin", bodyId: "cursor" } };
    const original = Buffer.from(JSON.stringify(bots));
    writeFileSync(file, original);
    writeFileSync(join(DATA_DIR, "mascot-profile-recovery"), "cannot create recovery directory");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => new Store(selection)).toThrow();
    expect(readFileSync(file)).toEqual(original);
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("keeps absent and explicit cursor bodies distinct through Store reload and team export", () => {
    const store = new Store(selection);
    const implicit = store.createBot({ name: "Implicit mascot" }, { seedMessages: false });
    const explicit = store.createBot({ name: "Explicit mascot", mascotBody: "cursor" }, { seedMessages: false });
    const persisted = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(persisted.find((bot) => bot.id === implicit.id)).not.toHaveProperty("mascotBody");
    expect(persisted.find((bot) => bot.id === explicit.id)).toHaveProperty("mascotBody", "cursor");

    const reloaded = new Store(selection);
    const implicitAfterReload = reloaded.bot(implicit.id)!;
    const explicitAfterReload = reloaded.bot(explicit.id)!;
    expect(implicitAfterReload).not.toHaveProperty("mascotBody");
    expect(explicitAfterReload).toHaveProperty("mascotBody", "cursor");

    const exported = createTeamManifest(
      { name: "Mascot presence", memberIds: [implicit.id, explicit.id] },
      [implicitAfterReload, explicitAfterReload],
    );
    expect(exported.team.members[0]!.appearance).not.toHaveProperty("mascotBody");
    expect(exported.team.members[1]!.appearance).toHaveProperty("mascotBody", "cursor");
  });
});

describe("Store bot order", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  // createBot puts the newest bot first, so four creations read [d, c, b, a].
  const fleet = (store: Store) => {
    const a = store.createBot({ name: "A" }, { seedMessages: false });
    const b = store.createBot({ name: "B" }, { seedMessages: false });
    const c = store.createBot({ name: "C" }, { seedMessages: false });
    const d = store.createBot({ name: "D" }, { seedMessages: false });
    return { a, b, c, d };
  };
  const order = (store: Store) => store.bots.map((bot) => bot.id);

  it("reorders the whole fleet, persists it, and emits one whole-list change", () => {
    const store = new Store(selection);
    const { a, b, c, d } = fleet(store);
    expect(order(store)).toEqual([d.id, c.id, b.id, a.id]);
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));
    const before = store.bots;
    expect(store.reorderBots([a.id, b.id, c.id, d.id])?.map((bot) => bot.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(changes).toEqual([{ type: "bots.order" }]);
    // Same array and same records: schedulers and other consumers hold these objects.
    expect(store.bots).toBe(before);
    expect(store.bot(a.id)).toBe(a);
    expect(order(new Store(selection))).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("is stable for the bots a partial list leaves out", () => {
    const store = new Store(selection);
    const { a, b, c, d } = fleet(store);
    // a and c sit at positions 3 and 1: a takes 1 and c takes 3; d and b never move.
    expect(store.reorderBots([a.id, c.id])?.map((bot) => bot.id)).toEqual([d.id, a.id, b.id, c.id]);
    expect(order(new Store(selection))).toEqual([d.id, a.id, b.id, c.id]);
    // Swapping two neighbours inside one bucket leaves the rest alone.
    expect(store.reorderBots([b.id, a.id])?.map((bot) => bot.id)).toEqual([d.id, b.id, a.id, c.id]);
  });

  it("refuses an empty list, a repeated id or an unknown id without touching anything", () => {
    const store = new Store(selection);
    const { a, b } = fleet(store);
    const saved = order(store);
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));
    for (const ids of [[], [a.id, a.id], [a.id, "missing"], ["missing"], [b.id, a.id, b.id]]) {
      expect(store.reorderBots(ids), JSON.stringify(ids)).toBeNull();
    }
    expect(changes).toEqual([]);
    expect(order(store)).toEqual(saved);
    expect(order(new Store(selection))).toEqual(saved);
  });
});

describe("Store change stream", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const record = (store: Store) => {
    const events: Array<Record<string, unknown>> = [];
    store.onChange((e) => events.push(e as unknown as Record<string, unknown>));
    return events;
  };

  it("emits once per write, after the write, with the record it wrote", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Quiet" }, { seedMessages: false });
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events).toEqual([{ type: "message", threadId: bot.threadId, message: m }]);
    expect(store.messagesFor(bot.threadId).at(-1)).toBe(m);
  });

  it("emits a card patch after a user message hides an open options card", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Quick question", subtitle: "", options: ["A", "B"] },
    });
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events.map((event) => event.type)).toEqual(["message", "message.patch"]);
    expect(events[0]).toEqual({ type: "message", threadId: bot.threadId, message: m });
    expect(events[1]).toMatchObject({
      type: "message.patch",
      threadId: bot.threadId,
      message: { id: quiz.id, card: { dismissed: true } },
    });
  });

  it("announces a new bot before its greeting", () => {
    const store = new Store(selection);
    const events = record(store);
    const bot = store.createBot();
    expect(events.map((event) => event.type)).toEqual(["bot", "message"]);
    expect(events[0]).toEqual({ type: "bot", botId: bot.id });
    expect(events.slice(1).every((event) => event.threadId === bot.threadId)).toBe(true);
  });

  it("every message-tree write emits a message or thread event", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a" });
    const events = record(store);
    store.patchMessage(bot.threadId, first.id, { text: "a2" });
    store.branchMessage(bot.threadId, first.id, "b");
    store.setActiveLeaf(bot.threadId, first.id);
    store.setReaction(bot.threadId, first.id, "user", { emoji: "👍", at: 1 });
    expect(events.map((e) => e.type)).toEqual(["message.patch", "message", "thread", "thread", "message.patch"]);
    expect(events[2]).toMatchObject({ type: "thread", threadId: bot.threadId, activeLeafId: (events[1] as any).message.id });
    expect(events[3]).toMatchObject({ type: "thread", threadId: bot.threadId, activeLeafId: first.id });
  });

  it("keeps a reaction line a reaction when it is retried unchanged, and makes it words when edited", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const asked = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Shall I send it?" });
    const line = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "👍", replyToId: asked.id, reaction: "👍" });
    expect(store.branchMessage(bot.threadId, line.id, "👍")).toMatchObject({ text: "👍", replyToId: asked.id, reaction: "👍" });
    expect(store.branchMessage(bot.threadId, line.id, "Yes, but tomorrow")).not.toHaveProperty("reaction");
  });

  it("keeps one reaction per person: a new one replaces theirs, and nobody else's", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Shall I send it?" });
    const react = (by: string, emoji: string | null) =>
      store.setReaction(bot.threadId, reply.id, by, emoji ? { emoji, at: 1 } : null)?.reactions;
    expect(react("p_alice", "👍")).toEqual([{ emoji: "👍", by: "p_alice", at: 1 }]);
    expect(react("p_bob", "👍")).toEqual([{ emoji: "👍", by: "p_alice", at: 1 }, { emoji: "👍", by: "p_bob", at: 1 }]);
    expect(react("p_alice", "👎")).toEqual([{ emoji: "👍", by: "p_bob", at: 1 }, { emoji: "👎", by: "p_alice", at: 1 }]);
    expect(react("p_bob", null)).toEqual([{ emoji: "👎", by: "p_alice", at: 1 }]);
    expect(react("p_alice", null)).toBeUndefined();
    expect(store.setReaction(bot.threadId, "no-such-message", "p_alice", null)).toBeNull();
  });

  it("announces screen frames whose pixels are pruned", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-1" });
    for (let i = 2; i <= 4; i += 1) {
      store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: `frame-${i}` });
    }
    const events = record(store);
    const newest = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-5" });
    expect(events).toEqual([
      { type: "message.patch", threadId: bot.threadId, message: { ...first, png: undefined } },
      { type: "message", threadId: bot.threadId, message: newest },
    ]);
  });

  it("createTask records which bot opened a thread, and the record survives a reload", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const opener = store.createBot();
    const own = store.createTask(bot.id, "By a person")!;
    expect(own).not.toHaveProperty("openedBy");
    const opened = store.createTask(bot.id, "By a bot", false, undefined, { botId: opener.id, name: opener.name, at: 7 })!;
    expect(opened.openedBy).toEqual({ botId: opener.id, name: opener.name, at: 7 });
    expect(store.bot(bot.id)!.threadId).toBe(own.threadId);
    expect(store.setTaskOpenedBy(bot.id, opened.threadId, { botId: opener.id, name: opener.name, delegationId: "d-1", at: 7 })!.openedBy)
      .toEqual({ botId: opener.id, name: opener.name, delegationId: "d-1", at: 7 });
    expect(store.setTaskOpenedBy(bot.id, "no-such-thread", { botId: opener.id, name: opener.name, at: 7 })).toBeNull();
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, opened.threadId)?.openedBy).toEqual({ botId: opener.id, name: opener.name, delegationId: "d-1", at: 7 });
    expect(reloaded.taskByThread(bot.id, own.threadId)).not.toHaveProperty("openedBy");
  });

  it("first-message titling preserves peer provenance and a person's rename", () => {
    const store = new Store(selection);
    const recipient = store.createBot({ name: "Scout" });
    const sender = store.createBot({ name: "Clive" });
    const brief = "Verify the export";
    const row = store.createTask(recipient.id, undefined, false, undefined, { botId: sender.id, name: sender.name, kind: "work", at: 10 })!;
    store.appendMessage(row.threadId, { role: "bot", kind: "text", text: `@Scout ${brief}`, at: 1_000 });
    const titled = store.titleTaskFromFirstMessage(recipient.id, `@Scout ${brief}`, row.threadId);
    expect(titled?.title).toBe(`@Scout ${brief}`);
    expect(titled?.openedBy?.botId).toBe(sender.id);
    store.renameTask(recipient.id, row.threadId, "Export verification");
    expect(store.retitleTask(recipient.id, row.threadId, `@Scout ${brief}`, "Late title")).toBeNull();
  });

  it("channel first-message titling reports the row it named, and a late retitle cannot undo a rename", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Scout" });
    const group = store.createGroup("Ops", [bot.id])!;
    const task = store.activeGroupTask(group.id)!;
    const titled = store.titleGroupTaskFromFirstMessage(group.id, "Audit the payroll", task.threadId);
    expect(titled?.threadId).toBe(task.threadId);
    expect(titled?.title).toBe("Audit the payroll");
    store.patchGroupTask(group.id, task.threadId, { title: "Payroll audit" });
    expect(store.retitleGroupTask(group.id, task.threadId, "Audit the payroll", "Payroll checks")).toBeNull();
    expect(store.activeGroupTask(group.id)!.title).toBe("Payroll audit");
    const fresh = store.createGroupTask(group.id)!.threadId;
    const freshSnippet = store.titleGroupTaskFromFirstMessage(group.id, "Draft the announcement", fresh)!.title;
    expect(store.retitleGroupTask(group.id, fresh, freshSnippet, "Draft announcement")).toMatchObject({ threadId: fresh });
    expect(store.retitleGroupTask(group.id, fresh, freshSnippet, "A second opinion")).toBeNull();
    expect(store.groupTaskByThread(group.id, fresh)!.title).toBe("Draft announcement");
  });

  it("loading collapses the duplicate live pair rows an older server minted, and a second load changes nothing", () => {
    const store = new Store(selection);
    const recipient = store.createBot({ name: "Scout" });
    const sender = store.createBot({ name: "Clive" });
    const older = store.createTask(recipient.id, "@Clive", false, undefined, { botId: sender.id, name: "Clive", kind: "pair", at: 1_000 })!;
    const olderAt = older.openedBy!.at;
    store.appendMessage(older.threadId, { role: "bot", kind: "text", text: "the predecessor's job", at: 1_000 });
    store.deleteBot(sender.id);
    const recreated = store.createBot({ name: "Clive" });
    const newer = store.createTask(recipient.id, "@Clive", false, undefined, { botId: recreated.id, name: "Clive", kind: "pair", at: 2_000 })!;
    const reloaded = new Store(selection);
    const kept = reloaded.taskByThread(recipient.id, newer.threadId)!;
    expect(kept.threadId).toBe(newer.threadId);
    const demoted = reloaded.taskByThread(recipient.id, older.threadId)!;
    expect(demoted.openedBy).toEqual({ botId: sender.id, name: "Clive", at: olderAt });
    expect(demoted.closedBy).toMatchObject({ botId: recreated.id, name: "Clive" });
    expect(reloaded.messagesFor(older.threadId).at(-1)?.text).toBe("the predecessor's job");
    expect(reloaded.tasks(recipient.id).filter((task) => task.openedBy?.kind === "pair")).toHaveLength(1);
    const again = new Store(selection);
    expect(again.taskByThread(recipient.id, older.threadId)).toEqual(demoted);
    expect(again.taskByThread(recipient.id, newer.threadId)!.openedBy).toEqual({ botId: recreated.id, name: "Clive", kind: "pair", at: 2_000 });
    expect(again.tasks(recipient.id).filter((task) => task.openedBy?.kind === "pair")).toHaveLength(1);
  });

  it("setTaskClosedBy stamps who closed a thread, survives a reload, and null reopens it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const closer = store.createBot();
    const task = store.createTask(bot.id, "Helper")!;
    expect(task).not.toHaveProperty("closedBy");
    expect(store.setTaskClosedBy(bot.id, task.threadId, { botId: closer.id, name: closer.name, at: 9 })!.closedBy)
      .toEqual({ botId: closer.id, name: closer.name, at: 9 });
    expect(store.setTaskClosedBy(bot.id, "no-such-thread", { botId: closer.id, name: closer.name, at: 9 })).toBeNull();
    expect(new Store(selection).taskByThread(bot.id, task.threadId)?.closedBy).toEqual({ botId: closer.id, name: closer.name, at: 9 });
    expect(store.setTaskClosedBy(bot.id, task.threadId, null)).not.toHaveProperty("closedBy");
    expect(new Store(selection).taskByThread(bot.id, task.threadId)).not.toHaveProperty("closedBy");
    expect(store.patchTask(bot.id, task.threadId, { closedBy: { botId: closer.id, name: closer.name, at: 1 } } as never)).not.toHaveProperty("closedBy");
  });

  it("every bot write emits a bot event carrying only the id (the wire shape is the caller's)", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const events = record(store);
    store.patchBot(bot.id, { name: "Zed" });
    store.createTask(bot.id, "t2");
    store.switchTask(bot.id, bot.threadId);
    store.renameTask(bot.id, bot.threadId, "renamed");
    store.setResumeCursor(bot.id, "claude", "s1", bot.threadId);
    store.pinTaskCwd(bot.id, bot.threadId, "/private/workspace");
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 5, costUsd: null });
    expect(events.every((e) => e.type === "bot" && e.botId === bot.id)).toBe(true);
    expect(events).toHaveLength(7);
    store.deleteBot(bot.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: bot.threadId });
    expect(events.at(-1)).toEqual({ type: "bot.deleted", botId: bot.id });
  });

  it("group writes emit group events; a listener that throws never breaks the write", () => {
    const store = new Store(selection);
    const a = store.createBot();
    const b = store.createBot();
    const events = record(store);
    store.onChange(() => {
      throw new Error("bad listener");
    });
    const g = store.createGroup("ops", [a.id, b.id]);
    store.patchGroup(g.id, { unread: true });
    expect(events.map((e) => e.type)).toEqual(["group", "group"]);
    expect(store.group(g.id)?.unread).toBe(true);
    store.deleteGroup(g.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: g.threadId });
    expect(events.at(-1)).toEqual({ type: "group.deleted", groupId: g.id });
  });

  it("delivers each change to the listener snapshot captured before emission", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    let removeSecond = () => {};
    store.onChange(() => {
      seen.push("first");
      removeSecond();
      store.onChange(() => seen.push("late"));
    });
    removeSecond = store.onChange(() => seen.push("second"));

    store.patchBot(bot.id, { name: "Snapshot" });

    expect(seen).toEqual(["first", "second"]);
  });

  it("unsubscribe stops delivery", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: unknown[] = [];
    const off = store.onChange((e) => seen.push(e));
    off();
    store.patchBot(bot.id, { name: "x" });
    expect(seen).toEqual([]);
  });
});

describe("Store bot activity state", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("derives busy from activity, so every existing busy reader keeps working", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.activity ?? "idle").toBe("idle");
    expect(Boolean(bot.busy)).toBe(false);
    for (const [state, busy] of [
      ["working", true],
      ["waiting-on-you", true],
      ["no-signal", true],
      ["idle", false],
      ["dead", false],
    ] as const) {
      store.setActivity(bot.id, state);
      expect(store.bot(bot.id)?.activity).toBe(state);
      expect(Boolean(store.bot(bot.id)?.busy)).toBe(busy);
    }
  });

  it("emits a bot change per transition and skips a no-op", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    store.onChange((c) => seen.push(c.type));
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "idle");
    expect(seen).toEqual(["bot", "bot"]);
  });

  it("neither activity nor busy survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setActivity(bot.id, "waiting-on-you");
    const again = new Store(selection);
    expect(again.bot(bot.id)?.activity).toBe("idle");
    expect(Boolean(again.bot(bot.id)?.busy)).toBe(false);
  });
});

describe("Store redacts bot-authored secrets on write", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("masks a key in bot text, tools and cards — but never in what the user typed", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Your key is ${key}` });
    expect(reply.text).not.toContain(key);
    expect(reply.text).toContain("«redacted");
    const chip = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Bash: export TOKEN=${key}`, ok: true, summary: `export TOKEN=${key}` },
      dataResult: { botId: bot.id, cardId: "c_1", title: `Revenue ${key}`, kind: "table", sql: `SELECT '${key}' AS token` },
    });
    expect(chip.tool?.name).not.toContain(key);
    expect(chip.tool?.summary).not.toContain(key);
    expect(chip.tool?.summary).toContain("«redacted");
    expect(chip.dataResult?.title).not.toContain(key);
    expect(chip.dataResult?.title).toContain("«redacted");
    expect(chip.dataResult?.sql).not.toContain(key);
    expect(chip.dataResult?.sql).toContain("«redacted");
    const card = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Run this?", summary: `curl -H "Authorization: Bearer ${key}"`, held: `Blocked ${key}`, options: [], requestId: "r1", tool: "Bash" } as never,
    });
    expect((card.card as { summary?: string }).summary).not.toContain(key);
    expect(card.card?.held).not.toContain(key);
    const routineCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Confirm routine",
        subtitle: "Every morning",
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: {
          version: 1,
          requestId: "routine-request",
          botId: bot.id,
          threadId: bot.threadId,
          createdAt: 1,
          operation: {
            action: "create",
            routine: {
              name: `Use ${key}`,
              instructions: `Send a request with ${key}`,
              schedule: { type: "daily", time: "09:00", weekdays: [1] },
              runOn: "maus",
              durationMinutes: 30,
            },
          },
        },
      },
    });
    expect(routineCard.card?.routineRequest?.operation.action).toBe("create");
    if (routineCard.card?.routineRequest?.operation.action !== "create") throw new Error("missing routine payload");
    expect(routineCard.card.routineRequest.operation.routine.name).not.toContain(key);
    expect(routineCard.card.routineRequest.operation.routine.instructions).not.toContain(key);
    const profileCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Update profile?",
        subtitle: "Why: because you asked",
        options: ["Confirm", "Cancel"],
        requestId: "profile-request",
        tool: "update_profile",
        profileRequest: {
          version: 1,
          requestId: "profile-request",
          botId: bot.id,
          threadId: bot.threadId,
          targetBotId: bot.id,
          targetName: `Scout ${key}`,
          createdAt: 1,
          reason: `because you asked about ${key}`,
          changes: { name: "Kiwi" },
          before: { name: "Scout", soul: `token ${key}` },
          expectedRevision: "r",
        },
      },
    });
    expect(profileCard.card?.profileRequest?.targetName).not.toContain(key);
    expect(profileCard.card?.profileRequest?.reason).not.toContain(key);
    expect(profileCard.card?.profileRequest?.before.soul).not.toContain(key);
    const skillCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Enable learned skill?",
        subtitle: "Review it first",
        options: ["Enable", "Dismiss"],
        requestId: "skill-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "skill-request",
          botId: bot.id,
          threadId: bot.threadId,
          stagedId: "staged-1",
          action: "create",
          name: "safe-skill",
          gist: `Uses ${key}`,
          source: `learn:${key}`,
          preview: `---\nname: safe-skill\ndescription: Uses ${key}.\n---\n`,
          sha256: "0".repeat(64),
          warnings: [`Found ${key}`],
          createdAt: 1,
        },
      },
    });
    expect(skillCard.card?.skillRequest?.gist).not.toContain(key);
    expect(skillCard.card?.skillRequest?.source).not.toContain(key);
    expect(skillCard.card?.skillRequest?.preview).not.toContain(key);
    expect(skillCard.card?.skillRequest?.sha256).toBeUndefined();
    expect(skillCard.card?.skillRequest?.warnings.join(" ")).not.toContain(key);

    const reviewedPreview = "---\nname: reviewed-skill\ndescription: Already scrubbed.\n---\n";
    const reviewedSha256 = createHash("sha256").update(reviewedPreview).digest("hex");
    const reviewedSkillCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Enable reviewed skill?",
        subtitle: "Review it first",
        options: ["Enable", "Deny"],
        requestId: "reviewed-skill-request",
        tool: "stage_skill",
        skillRequest: {
          version: 1,
          requestId: "reviewed-skill-request",
          botId: bot.id,
          threadId: bot.threadId,
          stagedId: "staged-2",
          action: "create",
          name: "reviewed-skill",
          gist: "Already scrubbed.",
          source: "learn:reviewed-skill",
          preview: reviewedPreview,
          sha256: reviewedSha256,
          warnings: [],
          createdAt: 2,
        },
      },
    });
    expect(reviewedSkillCard.card?.skillRequest?.preview).toBe(reviewedPreview);
    expect(reviewedSkillCard.card?.skillRequest?.sha256).toBe(reviewedSha256);
    const runCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "routine.run",
      text: `Routine ${key} completed`,
      routineRun: {
        runId: "run-1",
        routineId: "routine-1",
        routineName: `Report ${key}`,
        status: "completed",
        executionThreadId: "execution-1",
        summary: `Finished with ${key}`,
        error: `Ignored ${key}`,
      },
    });
    expect(runCard.routineRun?.routineName).not.toContain(key);
    expect(runCard.routineRun?.summary).not.toContain(key);
    expect(runCard.routineRun?.error).not.toContain(key);
    const secretCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "secret",
      secret: {
        target: "xaiApiKey",
        label: "xAI API key",
        description: `The agent accidentally included ${key}`,
        placeholder: "xai-…",
        helpUrl: "https://console.x.ai/",
        requestKey: "credential-request",
      },
    });
    expect(secretCard.secret?.description).not.toContain(key);
    const mine = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `use ${key} for the api` });
    expect(mine.text).toContain(key);
    const again = new Store(selection);
    expect(again.messagesFor(bot.threadId).find((m) => m.id === reply.id)?.text).not.toContain(key);
  });
});

describe("Store task usage", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("banks each turn's tokens and cost on the task, counting turns", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 100, output: 20, costUsd: 0.01 })).toMatchObject({
      input: 100,
      output: 20,
      costUsd: 0.01,
      turns: 1,
    });
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 50, output: 5, costUsd: 0.005 })).toMatchObject({
      input: 150,
      output: 25,
      costUsd: 0.015,
      turns: 2,
    });
    expect(store.taskByThread(bot.id, bot.threadId)?.usage).toMatchObject({ input: 150, output: 25, costUsd: 0.015, turns: 2 });
  });

  it("keeps cost null until some turn reports one, then sums only reported costs", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBeNull();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: 0.02 })?.costUsd).toBe(0.02);
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBe(0.02);
  });

  it("counts a turn that reported no tokens at all", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { costUsd: null })).toMatchObject({ input: 0, output: 0, costUsd: null, turns: 1 });
  });

  it("ignores an unknown task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, "nope", { input: 1, output: 1, costUsd: null })).toBeNull();
  });
});

describe("Store askedAt from before builds kept it", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("fills a thread's askedAt from the newest line a person sent there, once per data directory", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Upgraded" });
    const first = bot.threadId;
    const later = store.createTask(bot.id, "Later")!.threadId;
    const run = store.createTask(bot.id, "Run")!.threadId;
    store.patchTask(bot.id, run, { routineRunId: "run-1" });
    const asked = store.appendMessage(first, { role: "user", kind: "text", text: "Good morning.", sendId: "send-1" });
    store.appendMessage(first, { role: "bot", kind: "text", text: "Morning!" });
    store.appendMessage(later, { role: "user", kind: "text", text: "Report this run's state." });
    store.appendMessage(run, { role: "user", kind: "text", text: "Go.", sendId: "send-2" });
    expect(existsSync(join(DATA_DIR, "asked-at-filled"))).toBe(true);
    rmSync(join(DATA_DIR, "asked-at-filled"));
    const upgraded = new Store(selection);
    expect(upgraded.taskByThread(bot.id, first)?.askedAt).toBe(asked.at);
    expect(upgraded.taskByThread(bot.id, later)).not.toHaveProperty("askedAt");
    expect(upgraded.taskByThread(bot.id, run)).not.toHaveProperty("askedAt");
    expect(toWireTask(upgraded.taskByThread(bot.id, first)!, selection())).not.toHaveProperty("askedAt");
    upgraded.appendMessage(later, { role: "user", kind: "text", text: "Hello.", sendId: "send-3" });
    expect(new Store(selection).taskByThread(bot.id, later)).not.toHaveProperty("askedAt");
  });
});

describe("Store task working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the bot's folder onto a task on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });

    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/tmp/project-a");

    store.patchBot(bot.id, { cwd: "/tmp/project-b" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");

    const next = store.createTask(bot.id, "second")!;
    expect(store.pinTaskCwd(bot.id, next.threadId)).toBe("/tmp/project-b");
  });

  it("persists a new task's explicit folder before its first turn without changing the bot default", () => {
    const store = new Store(selection);
    const bot = store.createBot({ cwd: "/tmp/default-project" });
    const task = store.createTask(bot.id, "Explicit project", true, undefined, undefined, undefined, undefined, "/tmp/chosen-project")!;
    expect(task.cwd).toBe("/tmp/chosen-project");
    expect(bot.cwd).toBe("/tmp/default-project");
    const reloaded = new Store(selection);
    reloaded.patchBot(bot.id, { cwd: "/tmp/later-project" });
    expect(reloaded.pinTaskCwd(bot.id, task.threadId)).toBe("/tmp/chosen-project");
    expect(reloaded.createTask(bot.id)?.cwd).toBeUndefined();
  });

  it("pins a private-only conversation to its own folder when it first runs, and never moves one that already ran elsewhere", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    const ran = bot.threadId;
    expect(store.pinTaskCwd(bot.id, ran, "/tmp/private-old")).toBe("/tmp/project-a");
    const fresh = store.createTask(bot.id, "fresh")!;
    expect(store.pinTaskCwd(bot.id, fresh.threadId, "/tmp/private-fresh", { privateOnly: true })).toBe("/tmp/private-fresh");
    expect(store.pinTaskCwd(bot.id, ran, "/tmp/private-old", { privateOnly: true })).toBe("/tmp/project-a");
    expect(store.taskByThread(bot.id, ran)?.cwd).toBe("/tmp/project-a");
  });

  it("pins the default (null) when the bot has no folder, so a later folder can't move a live session", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
  });

  it("pins a supplied private workspace when the bot has no custom folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId, "/private/bot-workspace")).toBe("/private/bot-workspace");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/private/bot-workspace");
  });

  it("a legacy task that already has a session pins to the default, not the bot's new folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-1", bot.threadId);
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});

describe("Store room working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the room's folder on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });

    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");
    expect(store.group(group.id)?.pinnedCwd).toBe("/tmp/project-a");

    store.patchGroup(group.id, { cwd: "/tmp/project-b" });
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");

    const reloaded = new Store(selection);
    expect(reloaded.pinGroupCwd(group.id)).toBe("/tmp/project-a");
  });

  it("pins the default (null) when the room has no folder, so a later folder can't move a running room", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    expect(store.pinGroupCwd(group.id)).toBeNull();
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });
    expect(store.pinGroupCwd(group.id)).toBeNull();
    expect(store.group(group.id)?.pinnedCwd).toBeNull();
  });
});

describe("Store task working folder — cloud runs", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  it("a cloud run pins the default so the bot's host folder never shows for that task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.pinTaskCwd(bot.id, bot.threadId, undefined, { none: true })).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});

describe("soul", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("seeds an empty soul with its hash and writes the SOUL.md mirror on create", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.soul).toBe("");
    expect(bot.soulHash).toBe(soulHash(""));
    expect(readFileSync(soulFile(bot.id), "utf8")).toBe("");
  });

  it("setSoul rewrites the record, the hash, the mirror, and clears drift", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { soulDrift: true });
    const updated = store.setSoul(bot.id, "Be brief.");
    expect(updated?.soul).toBe("Be brief.");
    expect(updated?.soulHash).toBe(soulHash("Be brief."));
    expect(updated?.soulDrift).toBe(false);
    expect(readFileSync(soulFile(bot.id), "utf8")).toBe("Be brief.");
    expect(store.setSoul("nope", "x")).toBeNull();
  });

  it("backfills old bots' mirrors before the first non-soul history change", async () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Record<string, unknown>[];
    for (const record of raw) {
      delete record.soul;
      delete record.soulHash;
    }
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));
    rmSync(join(DATA_DIR, "bots", bot.id), { recursive: true, force: true });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.soul).toBe("");
    expect(reloaded.bot(bot.id)?.soulHash).toBe(soulHash(""));
    expect(readFileSync(soulFile(bot.id), "utf8")).toBe("");
    reloaded.patchBot(bot.id, { title: "Tracker" });
    recordProfileChange(bot.id, "user", "api", { title: "" }, { title: "Tracker" });
    await flushProfileHistory(bot.id);
    expect(readHistory(bot.id)).toMatchObject([{ field: "title", after: "Tracker" }]);
  });

  it("preserves externally edited mirrors on reload", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setSoul(bot.id, "canonical");
    writeFileSync(soulFile(bot.id), "user edit");
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.soul).toBe("canonical");
    expect(readFileSync(soulFile(bot.id), "utf8")).toBe("user edit");
  });

  it("keeps all profile fields, the receipt and mirror unchanged when persistence fails", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const before = JSON.parse(JSON.stringify(bot));
    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.patchBotProfile(bot.id, { name: "Kiwi", soul: "new", lastProfileRequestId: "card" })).toThrow("disk full");
    expect(bot).toEqual(before);
    expect(readFileSync(soulFile(bot.id), "utf8")).toBe("");
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].name).toBe(before.name);
    save.mockRestore();
    const emit = vi.fn();
    store.onChange(emit);
    store.patchBotProfile(bot.id, { name: "Kiwi", soul: "new", lastProfileRequestId: "card" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(new Store(selection).bot(bot.id)).toMatchObject({ name: "Kiwi", soul: "new", lastProfileRequestId: "card" });
  });

  it("keeps runtime revocations effective in memory even when persistence fails", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { browser: true });
    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.patchBot(bot.id, { browser: false })).toThrow("disk full");
    expect(bot.browser).toBe(false);
    save.mockRestore();
  });

  it("gives a teammate a restricted Chief's reviewed setup creates the Chief's own audience", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Board", section: "People", visibility: { people: ["hr@example.test"] } });
    store.patchBot(chief.id, { chiefOfStaff: true });
    const request: TeamSetupRequest = { version: 1, requestId: "setup-restricted", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "create", botId: "created-by-chief", threadId: "created-by-chief-thread", fields: { name: "Layoff Modeler", section: "People", modelSelection: selection() } },
      ] };
    store.applyTeamSetup(request);
    expect(new Store(selection).bot("created-by-chief")?.visibility).toEqual({ people: ["hr@example.test"] });
    expect(new Store(selection).bot("created-by-chief")).toMatchObject({ composio: false, connectorTools: {}, approvePeerComms: false });
    const open = new Store(selection);
    const everyoneChief = open.createBot({ name: "Ops", section: "Ops" });
    open.patchBot(everyoneChief.id, { chiefOfStaff: true });
    open.applyTeamSetup({ ...request, requestId: "setup-open", botId: everyoneChief.id, threadId: everyoneChief.threadId, operations: [
      { action: "create", botId: "created-open", threadId: "created-open-thread", fields: { name: "Helper", section: "Ops", modelSelection: selection() } },
    ] });
    expect(open.bot("created-open")?.visibility).toBeUndefined();
  });

  it("deleteBot removes the bot folder with the workspace", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(existsSync(soulFile(bot.id))).toBe(true);
    store.deleteBot(bot.id);
    expect(existsSync(join(DATA_DIR, "bots", bot.id))).toBe(false);
  });

  it("deleteBot removes the memory journal, the memory index, and the in-memory baseline", async () => {
    resetMemoryJournalState();
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createBot();
    journalMemoryWrite(bot.id, "memory/notes.md", "vendor list\n", { actor: "person", via: "ui" });
    journalMemoryWrite(other.id, "memory/notes.md", "other notes\n", { actor: "person", via: "ui" });
    await flushMemoryJournal(bot.id);
    await flushMemoryJournal(other.id);
    mdb.indexMemoryFile(bot.id, "memory/notes.md", "vendor list\n", { mtimeMs: 1, bytes: 12 });
    mdb.indexMemoryFile(other.id, "memory/notes.md", "other notes\n", { mtimeMs: 2, bytes: 12 });
    beginMemoryTurn(bot.id, bot.threadId);
    expect(endMemoryTurn(bot.threadId)).toEqual([]);
    expect(existsSync(journalFile(bot.id))).toBe(true);
    expect(mdb.indexedMemoryFiles(bot.id).map((file) => file.path)).toContain("memory/notes.md");

    expect(store.deleteBot(bot.id)).toBe(true);

    expect(existsSync(journalFile(bot.id))).toBe(false);
    expect(mdb.indexedMemoryFiles(bot.id)).toEqual([]);
    expect(mdb.recallMemory("vendor", bot.id)).toEqual([]);
    expect(existsSync(journalFile(other.id))).toBe(true);
    expect(mdb.indexedMemoryFiles(other.id).map((file) => file.path)).toEqual(["memory/notes.md"]);
    expect(mdb.recallMemory("notes", other.id).map((hit) => hit.file)).toEqual(["memory/notes.md"]);
    beginMemoryTurn(bot.id, "after-delete");
    expect(endMemoryTurn("after-delete")).toEqual([]);
    expect(existsSync(journalFile(bot.id))).toBe(false);

    mdb.closeMessageDb();
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      expect(() => raw.exec("INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')")).not.toThrow();
      const gone = raw.prepare("SELECT COUNT(*) AS n FROM memory_files WHERE bot_id = ?").get(bot.id) as { n: number };
      const kept = raw.prepare("SELECT COUNT(*) AS n FROM memory_files WHERE bot_id = ?").get(other.id) as { n: number };
      expect(gone.n).toBe(0);
      expect(kept.n).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("reviewed setup freezes legacy thread settings and persists valid team grants and its receipt on reload", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Clive", section: "Operations" });
    const bot = store.createBot({ name: "Patch", section: "Operations" });
    store.patchBot(chief.id, { chiefOfStaff: true, managedSections: Array.from({ length: 99 }, (_, i) => `Team ${i}`) });
    store.patchBot(bot.id, { approvalMode: "edits", autoApprove: false, alwaysAllow: ["Read"] });
    const task = bot.tasks![0];
    delete task.modelSelection; delete task.approvalMode; delete task.autoApprove; delete task.alwaysAllow;
    const name = "T".repeat(60);
    const request: TeamSetupRequest = { version: 1, requestId: "setup-reload", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [name], operations: [
        { action: "update", botId: bot.id, fields: { section: name, modelSelection: { instanceId: "codex", model: "fixture" } } },
      ] };
    const original = structuredClone(store.bots);
    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.applyTeamSetup(request)).toThrow("disk full");
    expect(store.bots).toEqual(original); save.mockRestore();
    const result = store.applyTeamSetup(request);
    expect(store.applyTeamSetup(request)).toEqual(result);
    const reloaded = new Store(selection);
    expect(reloaded.bot(chief.id)?.managedSections).toHaveLength(100);
    expect(reloaded.bot(chief.id)?.managedSections).toContain(name);
    expect(reloaded.bot(chief.id)?.lastTeamSetupReceipt?.requestId).toBe(request.requestId);
    expect(reloaded.bot(bot.id)).toMatchObject({ section: name, modelSelection: { instanceId: "codex", model: "fixture" } });
    expect(reloaded.bot(bot.id)?.tasks?.[0]).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    expect(reloaded.bot(bot.id)?.tasks?.[0].modelSelection).toBeUndefined();
    expect(reloaded.projectBotForTask(bot.id, bot.threadId)?.modelSelection).toEqual({ instanceId: "codex", model: "fixture" });
    expect(() => reloaded.applyTeamSetup({ ...request, requestId: "too-many", newTeams: ["Overflow"] })).toThrow(/scope/);
    expect(() => reloaded.applyTeamSetup({ ...request, requestId: "too-long", newTeams: ["X".repeat(61)] })).toThrow(/scope/);
    expect(reloaded.bot(chief.id)?.managedSections).toHaveLength(100);
  });

  it("persists reviewed Chief replacement atomically and revokes the outgoing Chief's grants", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Outgoing", section: "Operations" });
    const successor = store.createBot({ name: "Successor", section: "Operations" });
    store.patchBot(chief.id, { chiefOfStaff: true, managedSections: ["Engineering"] });
    const request: TeamSetupRequest = { version: 1, requestId: "leadership-reload", botId: chief.id, threadId: chief.threadId,
      reason: "Requested succession", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [
        { action: "update", botId: successor.id, fields: { chiefOfStaff: true } },
        { action: "update", botId: chief.id, fields: { chiefOfStaff: false } },
      ] };
    const before = structuredClone(store.bots);
    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.applyTeamSetup(request)).toThrow("disk full");
    expect(store.bots).toEqual(before); save.mockRestore();
    const result = store.applyTeamSetup(request);
    expect(result.bots.map(bot => bot.chiefOfStaff)).toEqual([true, false]);
    const reloaded = new Store(selection);
    expect(reloaded.bot(chief.id)?.chiefOfStaff).toBe(false);
    expect(reloaded.bot(chief.id)?.managedSections).toBeUndefined();
    expect(reloaded.bot(successor.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(successor.id)?.managedSections).toBeUndefined();
    expect(reloaded.bot(successor.id)?.tasks).toEqual(successor.tasks);
    expect(reloaded.applyTeamSetup(request)).toEqual(result);
  });

  it("reviewed deletion saves its receipt with removal before deleting any bot files", () => {
    const store = new Store(selection); const chief = store.createBot(); const bot = store.createBot();
    const request: TeamSetupRequest = { version: 1, requestId: "delete-reload", botId: chief.id, threadId: chief.threadId,
      reason: "Requested", createdAt: 1, requesterRevision: "fixture", newTeams: [], operations: [],
      deletion: { botId: bot.id, name: bot.name, expectedRevision: "fixture" } };
    const save = vi.spyOn(store as unknown as { saveBots(bots: BotRecord[]): void }, "saveBots")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.deleteBot(bot.id, request)).toThrow("disk full");
    expect(store.bot(bot.id)).toBe(bot); expect(store.bot(chief.id)?.lastTeamSetupReceipt).toBeUndefined();
    expect(existsSync(soulFile(bot.id))).toBe(true); expect(store.messagesFor(bot.threadId)).toHaveLength(1);
    save.mockRestore(); expect(store.deleteBot(bot.id, request)).toBe(true);
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toBeNull();
    expect(reloaded.bot(chief.id)?.lastTeamSetupReceipt).toMatchObject({ requestId: request.requestId, result: { state: "applied" } });
  });

  it("setSoul still returns the updated record when the mirror write fails", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const folder = join(DATA_DIR, "bots", bot.id);
    // A *file* at the bot's folder path makes writeSoulMirror's mkdirSync fail with ENOTDIR.
    rmSync(folder, { recursive: true, force: true });
    writeFileSync(folder, "not a directory");
    try {
      const call = () => store.setSoul(bot.id, "Be brief.");
      expect(call).not.toThrow();
      const updated = call();
      expect(updated?.soul).toBe("Be brief.");
      expect(updated?.soulHash).toBe(soulHash("Be brief."));
    } finally {
      rmSync(folder, { force: true });
    }
  });
});
