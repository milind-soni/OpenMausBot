import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { RoutineManager } from "./routines.ts";
import { createTeamBackup, importTeamBackup } from "./team-backup.ts";
import { parseTeamBackup } from "../shared/team-backup.ts";
import { soulFile, soulHash } from "./bot-folder.ts";

const selection = () => ({ instanceId: "fixture", model: "fixture-model" });

function fixture() {
  const store = new Store(selection);
  const routines = new RoutineManager({
    botState: (id) => store.bot(id) ? "ready" : "missing",
    goalState: (id, botId) => store.group(id)?.memberIds.includes(botId) ? "ready" : "missing",
    createTask: (id, title) => store.createTask(id, title),
    startTurn: async () => { throw new Error("Import must never run a bot"); },
  });
  const chief = store.createBot({ name: "Mira", section: "Engineering", description: "Full instructions\n".repeat(400) }, { seedMessages: false });
  store.setSoul(chief.id, "  Cite sources.\nRespect the user's current request. 🐭\n");
  const scout = store.createBot({ name: "Scout", section: "Engineering", mascotBody: "circle" }, { seedMessages: false });
  const otherChief = store.createBot({ name: "Ava", section: "Operations" }, { seedMessages: false });
  const archived = store.createBot({ name: "Archived" }, { seedMessages: false });
  store.patchBot(archived.id, { hidden: true });
  store.patchBot(chief.id, { chiefOfStaff: true, autoApprove: true, approvalMode: "full", alwaysAllow: ["Bash"], cwd: "/private/old-workspace", composio: true,
    playbooks: [{ key: "research", name: "Research", summary: "Find evidence", triggers: ["research"], instructions: "Cite sources" }] });
  store.setChiefOfStaff(otherChief.id);
  const root = store.appendMessage(chief.threadId, { role: "user", kind: "text", text: "Original question", at: 100 });
  const answer = store.appendMessage(chief.threadId, { role: "bot", kind: "text", text: "Original answer", at: 101 });
  store.branchMessage(chief.threadId, root.id, "Edited question");
  store.setActiveLeaf(chief.threadId, answer.id);
  store.renameTask(chief.id, chief.threadId, "First conversation");
  const active = store.createTask(chief.id, "Second conversation")!;
  store.appendMessage(active.threadId, { role: "user", kind: "text", text: "Current question", queued: true, queueId: "do-not-replay" });
  store.appendMessage(active.threadId, { role: "bot", kind: "options", card: {
    title: "Permission request", subtitle: "Old approval", options: ["Allow"], requestId: "do-not-resume", allowKey: "Bash",
  } });
  store.appendMessage(active.threadId, { role: "user", kind: "text", text: "An image", attachments: [{ kind: "image", path: "/private/image.png", mime: "image/png" }] });
  const group = store.createGroup("Project room", [chief.id, scout.id], false, "Engineering", {
    bulletin: "Build carefully", defaultResponder: { kind: "member", botId: chief.id }, completed: true,
  });
  store.appendMessage(group.threadId, { role: "bot", kind: "text", text: "Room answer", from: { botId: scout.id, name: scout.name, color: scout.color }, peerPost: { unattended: true } });
  store.createGroupTask(group.id, "Second room task", false);
  routines.create({ name: "Daily", prompt: "Report progress", botId: chief.id, enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
  routines.create({ name: "Standup", prompt: "Discuss progress", target: "room-goal", groupId: group.id, botId: chief.id, enabled: true, schedule: { type: "interval", everyMinutes: 30, anchorAt: 0 } });
  return { store, routines, chief, scout, otherChief, archived, group };
}

describe("additive portable team backups", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("round-trips all bots, sections, Chiefs, rooms, tasks and branches without changing originals", () => {
    const { store, routines, chief, scout, otherChief, archived, group } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const originalBots = structuredClone(store.bots);
    const originalGroups = structuredClone(store.groups);
    const originalRoutines = routines.listRoutines();
    const result = importTeamBackup(store, routines, JSON.parse(JSON.stringify(backup)), selection());
    expect(result.bots).toHaveLength(4);
    expect(result.groups).toHaveLength(1);
    for (const bot of originalBots) expect(store.bot(bot.id)).toEqual(bot);
    for (const room of originalGroups) expect(store.group(room.id)).toEqual(room);
    for (const routine of originalRoutines) expect(routines.listRoutines().find((r) => r.id === routine.id)).toEqual(routine);
    const importedChief = result.bots.find((bot) => bot.name === "Mira 2")!;
    const importedScout = result.bots.find((bot) => bot.name === "Scout 2")!;
    expect(importedChief.soul).toBe(chief.soul);
    expect(importedChief.soulHash).toBe(soulHash(chief.soul!));
    expect(readFileSync(soulFile(importedChief.id), "utf8")).toBe(chief.soul);
    expect(importedChief).toMatchObject({ section: "Engineering 2", chiefOfStaff: true, description: chief.description, computer: "off", composio: false, browser: false, approvalMode: "ask", autoApprove: false, resumeCursors: {}, playbooks: chief.playbooks });
    expect(result.bots.find((bot) => bot.name === "Ava 2")).toMatchObject({ section: "Operations 2", chiefOfStaff: true });
    expect(result.bots.find((bot) => bot.name === "Archived 2")).toMatchObject({ hidden: true });
    expect(importedChief).not.toHaveProperty("cwd");
    expect(importedChief).not.toHaveProperty("alwaysAllow");
    expect(store.bot(otherChief.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(archived.id)?.hidden).toBe(true);
    expect(importedScout.mascotBody).toBe(scout.mascotBody);
    expect(result.groups[0]).toMatchObject({ name: "Project room 2", section: "Engineering 2", memberIds: [importedChief.id, importedScout.id], defaultResponder: { kind: "member", botId: importedChief.id } });
    expect(result.groups[0].tasks?.map((task) => [task.title, task.createdAt])).toEqual(group.tasks?.map((task) => [task.title, task.createdAt]));
    const roomMessage = store.messagesFor(result.groups[0].threadId)[0];
    expect(roomMessage).toMatchObject({ text: "Room answer", from: { botId: importedScout.id }, peerPost: { unattended: true } });
    expect(result.routines.every((routine) => !routine.enabled && routine.nextRunAt === null)).toBe(true);
    expect(result.routines.find((routine) => routine.target === "room-goal")).toMatchObject({ botId: importedChief.id, groupId: result.groups[0].id });
    const firstTask = importedChief.tasks!.find((task) => task.title === "First conversation")!;
    expect(store.messagesFor(firstTask.threadId).map((message) => message.text)).toEqual(["Original question", "Original answer", "Edited question"]);
    expect(store.activePath(firstTask.threadId).map((message) => message.text)).toEqual(["Original question", "Original answer"]);
    const importedHistory = store.messagesFor(importedChief.threadId);
    expect(importedHistory.every((message) => message.kind === "text" && !message.queued && !message.card)).toBe(true);
    expect(importedHistory[1].text).toContain("Permission request");
    expect(importedHistory[2].text).toContain("file not included");
    expect(JSON.stringify(backup)).not.toMatch(/do-not-replay|do-not-resume|\/private\/image|\/private\/old-workspace|alwaysAllow|autoApprove|modelSelection/);
    const reloaded = new Store(selection);
    expect(reloaded.bot(importedChief.id)?.soul).toBe(chief.soul);
    expect(reloaded.activePath(firstTask.threadId)).toEqual(store.activePath(firstTask.threadId));
    expect(reloaded.bot(importedChief.id)?.tasks).toEqual(importedChief.tasks);
    expect(reloaded.messagesFor(chief.threadId)).toEqual(store.messagesFor(chief.threadId));
    // Re-import makes another independent set, not updates to either set.
    const second = importTeamBackup(store, routines, backup, selection());
    expect(second.bots.find((bot) => bot.name === "Mira 3")).toMatchObject({ section: "Engineering 3", chiefOfStaff: true });
    expect(store.bot(importedChief.id)).toEqual(importedChief);
  });

  it.each(["unknown-version", "duplicate-bot", "cycle", "dangling-room", "dangling-task", "duplicate-chief", "oversized-soul"])("rejects %s before any writes", (corruption) => {
    const { store, routines } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const before = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
    const groupsBefore = readFileSync(join(DATA_DIR, "groups.json"), "utf8");
    const source = backup.bots.find((bot) => bot.name === "Mira")!;
    if (corruption === "unknown-version") Object.assign(backup, { version: 2 });
    if (corruption === "duplicate-bot") backup.bots.push(source);
    if (corruption === "cycle") source.tasks[0].messages[0].parentId = source.tasks[0].messages[0].id;
    if (corruption === "dangling-room") backup.groups[0].memberIds.push("missing");
    if (corruption === "dangling-task") source.activeTask = "missing";
    if (corruption === "duplicate-chief") backup.bots.find((bot) => bot.name === "Scout")!.chiefOfStaff = true;
    if (corruption === "oversized-soul") source.soul = "🐭".repeat(6_001);
    expect(() => importTeamBackup(store, routines, backup, selection())).toThrow("Invalid backup");
    expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(before);
    expect(readFileSync(join(DATA_DIR, "groups.json"), "utf8")).toBe(groupsBefore);
  });

  it("accepts legacy backups without soul and enforces its UTF-8 byte cap", () => {
    const { store, routines } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "Legacy team");
    for (const bot of backup.bots) delete bot.soul;
    expect(importTeamBackup(store, routines, backup, selection()).bots.every((bot) => bot.soul === "")).toBe(true);
    backup.bots[0].soul = "🐭".repeat(6_000);
    expect(parseTeamBackup(backup).bots[0].soul).toBe(backup.bots[0].soul);
    backup.bots[0].soul += "!";
    expect(() => parseTeamBackup(backup)).toThrow("24000 bytes");
  });

  it("strips injected permissions, IDs and live actions from untrusted files", () => {
    const { store, routines, chief } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const source = backup.bots.find((bot) => bot.name === "Mira")!;
    Object.assign(source, { id: chief.id, threadId: chief.threadId, cwd: "/tmp", composio: true, approvalMode: "full", autoApprove: true, browser: true, computer: "local", resumeCursors: { fixture: "secret-session" } });
    Object.assign(source.tasks[0].messages[0], { kind: "options", queued: true, card: { requestId: "live-approval" }, attachments: [{ path: "/etc/passwd" }] });
    const imported = importTeamBackup(store, routines, backup, selection()).bots.find((bot) => bot.name === "Mira 2")!;
    expect(imported.id).not.toBe(chief.id);
    expect(imported.threadId).not.toBe(chief.threadId);
    expect(imported.approvalMode).toBe("ask");
    expect(JSON.stringify(parseTeamBackup(backup))).not.toMatch(/live-approval|secret-session|\/etc\/passwd|approvalMode/);
  });

  it("rolls back fresh bots, rooms and transcripts after a late failure", () => {
    const { store, routines } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const before = createTeamBackup(store, routines.listRoutines(), "My team");
    const write = vi.spyOn(routines, "create").mockImplementationOnce(() => { throw new Error("fixture disk failure"); });
    expect(() => importTeamBackup(store, routines, backup, selection())).toThrow("fixture disk failure");
    write.mockRestore();
    const after = createTeamBackup(new Store(selection), routines.listRoutines(), "My team");
    expect({ ...after, exportedAt: 0 }).toEqual({ ...before, exportedAt: 0 });
  });

  it("refuses to populate a thread that already has history", () => {
    const { store, chief } = fixture();
    const before = structuredClone(store.messagesFor(chief.threadId));
    expect(() => store.importTranscript(chief.threadId, [], null)).toThrow("existing conversation");
    expect(store.messagesFor(chief.threadId)).toEqual(before);
  });

  it("also rolls back a creation that throws before returning its new record", () => {
    const { store, routines } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const before = structuredClone(store.bots);
    const create = store.createBot.bind(store);
    const fail = vi.spyOn(store, "createBot").mockImplementationOnce((...args) => {
      create(...args);
      throw new Error("creation failed before returning");
    });
    expect(() => importTeamBackup(store, routines, backup, selection())).toThrow("creation failed");
    fail.mockRestore();
    expect(store.bots).toEqual(before);
    expect(new Store(selection).bots.map((bot) => bot.id)).toEqual(before.map((bot) => bot.id));
  });

  it("keeps case-distinct sections and their Chiefs separate", () => {
    const { store, routines } = fixture();
    const second = store.createBot({ name: "Another chief", section: "engineering" }, { seedMessages: false });
    store.setChiefOfStaff(second.id);
    const imported = importTeamBackup(store, routines, createTeamBackup(store, routines.listRoutines(), "My team"), selection());
    const chief = imported.bots.find((bot) => bot.name === "Mira 2")!;
    const other = imported.bots.find((bot) => bot.name === "Another chief 2")!;
    expect(chief.chiefOfStaff).toBe(true);
    expect(other.chiefOfStaff).toBe(true);
    expect(chief.section?.toLowerCase()).not.toBe(other.section?.toLowerCase());
    const reloaded = new Store(selection);
    expect(reloaded.bot(chief.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(other.id)?.chiefOfStaff).toBe(true);
  });

  it("backs up room history even when old deletions left dangling memberships and routines", () => {
    const { store, routines, chief, scout, group } = fixture();
    const dm = store.createGroup("Old direct message", [chief.id, scout.id], true);
    store.appendMessage(dm.threadId, { role: "bot", kind: "text", text: "Keep this old reply", from: { botId: chief.id, name: chief.name, color: chief.color } });
    store.deleteBot(chief.id);
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    expect(backup.warnings).toHaveLength(4);
    expect(backup.routines).toEqual([]);
    expect(backup.groups.find((room) => room.key === group.id)).toMatchObject({ memberIds: [scout.id], defaultResponder: { kind: "mentions" } });
    expect(backup.groups.find((room) => room.key === dm.id)?.dm).toBe(false);
    const restored = importTeamBackup(store, routines, backup, selection());
    const restoredDm = restored.groups.find((room) => room.name === "Old direct message 2")!;
    expect(store.messagesFor(restoredDm.threadId)[0]).toMatchObject({ text: "Mira:\nKeep this old reply" });
    // Exporting never repairs or removes the original records in place.
    expect(store.group(group.id)?.memberIds).toEqual([chief.id, scout.id]);
  });
});
