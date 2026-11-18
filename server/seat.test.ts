// Checked-against: server/fresh-start.test.ts (same Store fixture; covers Start fresh, not the hand-off note).
import { afterEach, describe, expect, it } from "vitest";

import { selectReplay } from "./context-rebuild.ts";
import { isContextMessage } from "./delta-context.ts";
import { armIdleClose, stopIdleClose } from "./drivers/session-idle.ts";
import { engineSessionOutdated } from "./fresh-start.ts";
import { closeSeat, HANDOFF_REQUEST, handoffNote, seatCloseRefusal } from "./seat.ts";
import { Store, type Message } from "./store.ts";

const NOTE = "Got the parser passing. Next: wire it into the import screen. Do not touch the old CSV path.";
const question = { title: "Q", subtitle: "Which file?", options: ["A"], requestId: "ask-1", requestType: "question" as const };

function setup() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture-model" }));
  const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
  const say = (role: "user" | "bot", text: string): Message => store.appendMessage(bot.threadId, { role, kind: "text", text });
  say("user", "Build the parser");
  say("bot", "Working on it");
  store.patchTask(bot.id, bot.threadId, { resumeCursors: { claude: "old-session" } });
  return { store, bot, say };
}

/** What the next turn would send in place of the old session, built the way the turn builds it. */
function nextContext(store: Store, threadId: string) {
  const path = store.activePath(threadId);
  const record = path.findLast((message) => message.kind === "compaction" && message.compaction);
  const history = path.filter(isContextMessage).map((message) => ({
    id: message.id, role: message.role === "user" ? "user" as const : "assistant" as const, text: message.kind === "compaction" ? "" : message.text ?? "",
  }));
  return selectReplay(history, { compaction: record?.compaction ? { ...record.compaction, id: record.id } : undefined });
}

const timers: Array<[string, ReturnType<typeof setTimeout>]> = [];
afterEach(() => { for (const [key, timer] of timers.splice(0)) stopIdleClose(key, timer); });

describe("the hand-off note", () => {
  it("is the bot's answer to the hand-off request, and nothing once the person writes again", () => {
    const { store, bot, say } = setup();
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
    say("user", HANDOFF_REQUEST);
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
    const note = say("bot", NOTE);
    expect(handoffNote(store.activePath(bot.threadId))?.id).toBe(note.id);
    say("user", "One more thing");
    expect(handoffNote(store.activePath(bot.threadId))).toBeNull();
  });
});

describe("closing a seat", () => {
  it("is refused while the bot works, while a card waits on the person, and before the note, naming which", () => {
    const { store, bot, say } = setup();
    expect(seatCloseRefusal(store, bot.threadId, true)?.errorKey).toBe("serverError.seat.busy");
    expect(seatCloseRefusal(store, bot.threadId, false)?.errorKey).toBe("serverError.seat.noNote");
    say("user", HANDOFF_REQUEST);
    say("bot", NOTE);
    const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { ...question } });
    expect(seatCloseRefusal(store, bot.threadId, false)).toMatchObject({ errorKey: "serverError.seat.waiting", errorParams: { kind: "question" } });
    store.patchMessage(bot.threadId, card.id, { card: { ...question, answered: "answer" } });
    expect(seatCloseRefusal(store, bot.threadId, false)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ claude: "old-session" });
  });

  it("saves the note as the brief of a new session, drops the old one and closes the engine kept for it", () => {
    const { store, bot, say } = setup();
    say("user", HANDOFF_REQUEST);
    say("bot", NOTE);
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
});
