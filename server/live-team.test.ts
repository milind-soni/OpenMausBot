import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb, deleteThread, recordStudioResult, studioResults } from "./message-db.ts";
import { Store } from "./store.ts";
import { _loadPending, recordDelegationReceipt } from "./delegations.ts";
import { buildStudioSnapshot, StudioTurnOutcomes, type StudioRuntime } from "./live-team.ts";
const runtime = (): StudioRuntime => ({ workspaceId: "test", running: [], speakers: [], queues: {}, computerHelp: [] });
let store: Store;
beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _loadPending(); store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" })); });
describe("studio metadata", () => {
  it("filters hidden bots and rooms and bounds result pages without losing terminal identities", () => {
    const visible = store.createBot({ name: "Visible", section: "Work" }, { seedMessages: false });
    const hidden = store.createBot({ name: "Hidden", section: "Other" }, { seedMessages: false });
    store.patchBot(hidden.id, { hidden: true });
    for (let i = 0; i < 57; i++) recordStudioResult({ id: `r${i}`, botId: visible.id, threadId: visible.threadId, turnId: `turn${i}`, finishedAt: i, title: "Result", status: "completed" });
    recordStudioResult({ id: "private", botId: hidden.id, threadId: hidden.threadId, turnId: "private", finishedAt: 100, title: "Secret", status: "completed" });
    const first = buildStudioSnapshot(store, runtime(), new URLSearchParams());
    expect(first.rooms.map((room) => room.id)).toEqual(["Work"]);
    expect(first.results.items).toHaveLength(50);
    expect(first.results.total).toBe(57);
    expect(JSON.stringify(first)).not.toContain("Secret");
    expect(buildStudioSnapshot(store, runtime(), new URLSearchParams("resultsOffset=50")).results.items).toHaveLength(7);
    closeMessageDb();
    expect(studioResults([visible.threadId]).total).toBe(57);
    recordStudioResult({ id: "r0", botId: visible.id, threadId: visible.threadId, turnId: "turn0", finishedAt: 999, title: "duplicate", status: "failed" });
    expect(studioResults([visible.threadId]).total).toBe(57);
  });
  it("keeps all pending attention counted, even beyond its visible page, and removes answered cards", () => {
    const bot = store.createBot({ name: "Busy", section: "Work" }, { seedMessages: false });
    const second = store.createBot({ name: "Second", section: "Work" }, { seedMessages: false });
    for (let i = 0; i < 51; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Question", subtitle: "Which direction?", options: [], requestId: `q${i}` } });
    const last = store.appendMessage(second.threadId, { role: "bot", kind: "options", card: { title: "Approval", subtitle: "Review the action", options: ["Allow", "Deny"], requestId: "last", tool: "Bash" } });
    store.patchMessage(second.threadId, last.id, { at: Date.now() + 1000 });
    const first = buildStudioSnapshot(store, runtime(), new URLSearchParams());
    expect(first.attention.items).toHaveLength(50);
    expect(first.attention.total).toBe(52);
    expect(first.stations.find((station) => station.botId === second.id)?.attentionCount).toBe(1);
    expect(buildStudioSnapshot(store, runtime(), new URLSearchParams("attentionOffset=50")).attention.items).toContainEqual(expect.objectContaining({ messageId: last.id, requestId: "last", kind: "approval" }));
    store.patchMessage(second.threadId, last.id, { card: { ...last.card!, answered: "allow" } });
    expect(buildStudioSnapshot(store, runtime(), new URLSearchParams()).attention.total).toBe(51);
  });
  it("keeps repeated and reverse handoffs distinct and independent of result pagination", () => {
    const a = store.createBot({ name: "A", section: "Work" }, { seedMessages: false });
    const b = store.createBot({ name: "B", section: "Work" }, { seedMessages: false });
    const live = runtime();
    live.running = [{ id: "one", sourceBotId: a.id, targetBotId: b.id, sourceThreadId: a.threadId, targetThreadId: b.threadId, sourceMessageId: "request1", startedAt: 100 }, { id: "two", sourceBotId: a.id, targetBotId: b.id, sourceThreadId: a.threadId, targetThreadId: b.threadId, startedAt: 101 }];
    recordDelegationReceipt({ id: "reverse", sourceBotId: b.id, sourceThreadId: b.threadId, toBotId: a.id, toBotName: "A", targetThreadId: a.threadId, sourceMessageId: "request3", status: "denied" });
    const first = buildStudioSnapshot(store, live, new URLSearchParams());
    expect(first.handoffs.items.map((item) => item.id)).toEqual(["two", "one", "reverse"]);
    expect(first.handoffs.items[1].sourceMessageId).toBe("request1");
    expect(buildStudioSnapshot(store, live, new URLSearchParams("resultsOffset=50")).handoffs).toEqual(first.handoffs);
    _loadPending();
    expect(buildStudioSnapshot(store, live, new URLSearchParams()).handoffs.items[2]).toMatchObject({ sourceBotId: b.id, targetBotId: a.id, sourceMessageId: "request3" });
  });
  it("filters a bot's question list while preserving other stations' assistance counts", () => {
    const a = store.createBot({ name: "A", section: "Work" }, { seedMessages: false });
    const b = store.createBot({ name: "B", section: "Work" }, { seedMessages: false });
    for (let i = 0; i < 52; i++) store.appendMessage(a.threadId, { role: "bot", kind: "options", card: { title: "Question", subtitle: "Choose", options: [], requestId: `a${i}` } });
    const question = store.appendMessage(b.threadId, { role: "bot", kind: "options", card: { title: "Question", subtitle: "Choose", options: [], requestId: "b" } });
    const live = runtime();
    live.computerHelp = [{ botId: a.id, requestId: "help-a" }, { botId: b.id, requestId: "help-b" }];
    const filtered = buildStudioSnapshot(store, live, new URLSearchParams({ attentionBotId: b.id }));
    expect(filtered.attention.total).toBe(2);
    expect(filtered.attention.items.map((item) => item.requestId)).toEqual(["b", "help-b"]);
    expect(filtered.stations.find((station) => station.botId === a.id)?.attentionCount).toBe(53);
    store.patchMessage(b.threadId, question.id, { card: { ...question.card!, dismissed: true } });
    expect(buildStudioSnapshot(store, live, new URLSearchParams({ attentionBotId: b.id })).attention.total).toBe(1);
  });
  it("preserves failure and interruption outcomes and removes deleted-thread result metadata", () => {
    const bot = store.createBot({ name: "Bot" }, { seedMessages: false });
    for (const status of ["failed", "interrupted"] as const) recordStudioResult({ id: status, botId: bot.id, threadId: bot.threadId, turnId: status, finishedAt: 1, title: status, status });
    expect(new Set(buildStudioSnapshot(store, runtime(), new URLSearchParams()).results.items.map((item) => item.status))).toEqual(new Set(["failed", "interrupted"]));
    deleteThread(bot.threadId);
    expect(studioResults([bot.threadId]).total).toBe(0);
  });
  it("rejects malformed paging and emits no content fields", () => {
    expect(() => buildStudioSnapshot(store, runtime(), new URLSearchParams("resultsOffset=-1"))).toThrow("Invalid");
    expect(() => buildStudioSnapshot(store, runtime(), new URLSearchParams("attentionOffset=1.2"))).toThrow("Invalid");
    expect(buildStudioSnapshot(store, runtime(), new URLSearchParams()).stations).toEqual([]);
  });
});

describe("studio terminal outcomes", () => {
  it("correlates explicit stops to one turn without converting later failures or successful races", () => {
    const outcomes = new StudioTurnOutcomes();
    outcomes.start("a", "old");
    outcomes.interrupt("a");
    outcomes.start("a", "new");
    expect(outcomes.finish("a", "old", false, "exit_before_result")).toBe("interrupted");
    expect(outcomes.finish("a", "new", false, "exit_before_result")).toBe("failed");
    outcomes.start("a", "race");
    outcomes.interrupt("a");
    expect(outcomes.finish("a", "race", true, "end_turn")).toBe("completed");
    expect(outcomes.finish("b", "provider", false, "interrupted")).toBe("interrupted");
    outcomes.interrupt("unknown");
    expect(outcomes.finish("unknown", "later", false, "exit_before_result")).toBe("failed");
  });
});
