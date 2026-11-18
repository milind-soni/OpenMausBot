import { afterEach, describe, expect, it, vi } from "vitest";

import { selectReplay } from "./context-rebuild.ts";
import { isContextMessage } from "./delta-context.ts";
import { armIdleClose, stopIdleClose } from "./drivers/session-idle.ts";
import { engineMemory } from "./engine-memory.ts";
import { engineSessionOutdated } from "./fresh-start.ts";
import { closeSeat, HANDOFF_REQUEST, handoffNote, seatCloseRefusal } from "./seat.ts";
import { Store, type Message } from "./store.ts";

const NOTE = "Got the parser passing. Next: wire it into the import screen. Do not touch the old CSV path.";
const question = { title: "Q", subtitle: "Which file?", options: ["A"], requestId: "ask-1", requestType: "question" as const };

// A box with room for every idle engine, whatever this host has: arming a second fake engine never closes the first.
vi.mock("./box-memory.ts", async (original) => ({
  ...await original<typeof import("./box-memory.ts")>(),
  boxMemory: () => ({ bytes: 16 * 1024 ** 3, cgroupLimit: null }),
  availableMemory: () => 8 * 1024 ** 3,
}));

function setup() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture-model" }));
  const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
  const say = (role: "user" | "bot", text: string): Message => store.appendMessage(bot.threadId, { role, kind: "text", text });
  /** A line of the turn `asked` started, as the runtime writes it; `last` once that turn settled with these words. */
  const answer = (asked: Message, text: string, { last = true, ok = true } = {}): Message => store.appendMessage(bot.threadId, {
    role: "bot", kind: "text", text, turnId: `turn-${asked.id}`, requestMessageId: asked.id, ...(last ? { turnTerminal: true, turnSucceeded: ok } : {}),
  });
  say("user", "Build the parser");
  say("bot", "Working on it");
  store.patchTask(bot.id, bot.threadId, { resumeCursors: { claude: "old-session" } });
  return { store, bot, say, answer };
}

/** What selectReplay gives from the stored rows and the newest summary. The history here is built by this test, not by
 * the turn builder in index.ts, so this checks the records the close leaves, not what an engine receives. */
function nextContext(store: Store, threadId: string) {
  const path = store.activePath(threadId);
  const record = path.findLast((message) => message.kind === "compaction" && message.compaction);
  const history = path.filter(isContextMessage).map((message) => ({
    id: message.id, role: message.role === "user" ? "user" as const : "assistant" as const, text: message.kind === "compaction" ? "" : message.text ?? "",
  }));
  return selectReplay(history, { compaction: record?.compaction ? { ...record.compaction, id: record.id } : undefined });
}

const timers: Array<[string, ReturnType<typeof setTimeout>]> = [];
afterEach(() => {
  for (const [key, timer] of timers.splice(0)) stopIdleClose(key, timer);
  vi.restoreAllMocks();
});

describe("the hand-off note", () => {
  it("is the bot's answer to the hand-off request, and nothing once the person writes again", () => {
    const { store, bot, say, answer } = setup();
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
    const asked = say("user", HANDOFF_REQUEST);
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
    const note = answer(asked, NOTE);
    expect(handoffNote(store.activePath(bot.threadId))?.id).toBe(note.id);
    say("user", "One more thing");
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
  });

  it("is the last words of the turn the request started, never a step of it or a bot line from elsewhere", () => {
    const { store, bot, say, answer } = setup();
    const asked = say("user", HANDOFF_REQUEST);
    answer(asked, "Reading the files first", { last: false });
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
    const note = answer(asked, NOTE);
    say("bot", "Webhook: build 412 passed");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Stayed on the new model", turnId: "turn-other", turnTerminal: true, turnSucceeded: true });
    expect(handoffNote(store.activePath(bot.threadId))?.id).toBe(note.id);
  });

  it("is nothing when the turn that answered the request failed", () => {
    const { store, bot, say, answer } = setup();
    answer(say("user", HANDOFF_REQUEST), "The model is unavailable", { ok: false });
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
  });
});

describe("closing a seat", () => {
  it("is refused while the bot works, while a card waits on the person, and before the note, naming which", () => {
    const { store, bot, say, answer } = setup();
    expect(seatCloseRefusal(store, bot.threadId, true)?.errorKey).toBe("serverError.seat.busy");
    expect(seatCloseRefusal(store, bot.threadId, false)?.errorKey).toBe("serverError.seat.noNote");
    answer(say("user", HANDOFF_REQUEST), NOTE);
    const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { ...question } });
    expect(seatCloseRefusal(store, bot.threadId, false)).toMatchObject({ errorKey: "serverError.seat.waiting", errorParams: { kind: "question" } });
    store.patchMessage(bot.threadId, card.id, { card: { ...question, answered: "answer" } });
    expect(seatCloseRefusal(store, bot.threadId, false)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ claude: "old-session" });
  });

  it("saves the note as the brief of a new session, drops the old one and closes the engine kept for it", () => {
    const { store, bot, say, answer } = setup();
    answer(say("user", HANDOFF_REQUEST), NOTE);
    vi.spyOn(engineMemory, "idleEnginesAllowed").mockReturnValue(Infinity);
    const closed: string[] = [];
    const engine = (threadId: string) => ({ idle: () => true, close: () => { closed.push(threadId); }, threadId });
    for (const threadId of [bot.threadId, "other-thread"]) timers.push([`claude\0${threadId}`, armIdleClose(`claude\0${threadId}`, 600_000, engine(threadId))]);

    const saved = closeSeat(store, bot.id, bot.threadId);
    expect(saved).toMatchObject({ role: "bot", kind: "compaction", compaction: { summary: NOTE, firstKeptId: "", by: "person" } });
    expect(closed).toEqual([bot.threadId]);
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});
    expect(engineSessionOutdated(store, bot.id, bot.threadId)).toBe(true);
    const next = nextContext(store, bot.threadId);
    expect(next.transcript.map((entry) => entry.id)).toEqual([saved!.id]);
    expect(next.transcript[0]!.text).toContain(NOTE);
    expect(next.transcript[0]!.text).not.toContain("Build the parser");

    expect(closeSeat(store, bot.id, bot.threadId)?.id).toBe(saved!.id);
    expect(store.activePath(bot.threadId).filter((message) => message.kind === "compaction")).toHaveLength(1);
  });

  it("saves the note once though a later row follows its summary, and never takes a /compact through the note for it", () => {
    const { store, bot, say, answer } = setup();
    const note = answer(say("user", HANDOFF_REQUEST), NOTE);
    const compacted = store.appendMessage(bot.threadId, {
      role: "bot", kind: "compaction", compaction: { summary: "The whole conversation so far", firstKeptId: "", foldedThroughId: note.id, tokensBefore: 900, by: "person" },
    });

    const saved = closeSeat(store, bot.id, bot.threadId);
    expect(saved?.id).not.toBe(compacted.id);
    expect(saved?.compaction).toMatchObject({ summary: NOTE, foldedThroughId: note.id });
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});

    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", text: "Closed the browser" });
    expect(closeSeat(store, bot.id, bot.threadId)?.id).toBe(saved!.id);
    expect(store.activePath(bot.threadId).filter((message) => message.kind === "compaction").map((message) => message.id)).toEqual([compacted.id, saved!.id]);

    const second = answer(say("user", HANDOFF_REQUEST), "Import screen wired. Next: the export.");
    const again = closeSeat(store, bot.id, bot.threadId);
    expect(again?.id).not.toBe(saved!.id);
    expect(again?.compaction).toMatchObject({ summary: "Import screen wired. Next: the export.", foldedThroughId: second.id });
  });
});
