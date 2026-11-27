import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string;

async function freshRoom() {
  home = mkdtempSync(join(tmpdir(), "omb-room-close-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const close = await import("./room-thread-close.ts");
  const { markGroupThreadUnreadAfterTurn } = await import("./group-task-state.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot();
  const room = store.createGroup("Launch", [bot.id]);
  return { store, bot, room, thread: room.threadId, close, turnEnds: () => markGroupThreadUnreadAfterTurn(store, room.id, room.threadId, null) };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const writer = { kind: "person" as const, id: "ada", name: "Ada" };

describe("closing a room thread", () => {
  it("keeps who closed it and when, and a person's line or a bot's reply opens it again", async () => {
    const { store, bot, room, thread, close } = await freshRoom();
    store.appendMessage(thread, { role: "user", kind: "text", text: "Ship it" });
    const closed = close.setRoomThreadClosed(store, room.id, thread, writer)!;
    expect(closed).toMatchObject({ closedBy: writer, closedAt: expect.any(Number) });

    store.appendMessage(thread, { role: "bot", kind: "activity", from: { botId: bot.id, name: bot.name, color: bot.color }, tool: { name: "Read", ok: true } });
    store.appendMessage(thread, { role: "bot", kind: "digest", text: "[digest] done" });
    expect(store.groupTaskByThread(room.id, thread)?.closedAt).toBe(closed.closedAt);

    store.appendMessage(thread, { role: "bot", kind: "text", text: "One more thing", from: { botId: bot.id, name: bot.name, color: bot.color } });
    expect(store.groupTaskByThread(room.id, thread)).not.toHaveProperty("closedAt");
    expect(store.groupTaskByThread(room.id, thread)).not.toHaveProperty("closedBy");

    close.setRoomThreadClosed(store, room.id, thread, writer);
    store.appendMessage(thread, { role: "user", kind: "text", text: "Wait, also this" });
    expect(store.groupTaskByThread(room.id, thread)?.closedAt).toBeUndefined();
  });

  it("leaves the thread unread when closing", async () => {
    const { store, room, thread, close } = await freshRoom();
    store.markGroupThreadUnread(room.id, thread, true);
    close.setRoomThreadClosed(store, room.id, thread, writer);
    expect(store.groupTaskByThread(room.id, thread)).toMatchObject({ unread: true, closedAt: expect.any(Number) });
  });

  it("closes for a bot when its turn ends, after its own reply", async () => {
    const { store, bot, room, thread, close, turnEnds } = await freshRoom();
    store.appendMessage(thread, { role: "user", kind: "text", text: "Fix the typo" });
    close.closeRoomThreadAtTurnEnd(thread, bot);
    store.appendMessage(thread, { role: "bot", kind: "text", text: "Fixed.", from: { botId: bot.id, name: bot.name, color: bot.color } });
    expect(store.groupTaskByThread(room.id, thread)?.closedAt).toBeUndefined();
    turnEnds();
    expect(store.groupTaskByThread(room.id, thread)).toMatchObject({ closedBy: { kind: "bot", id: bot.id, name: bot.name }, unread: true });
    turnEnds();
    expect(store.groupTaskByThread(room.id, thread)?.closedBy?.kind).toBe("bot");
  });

  it("drops a bot's close when a person writes before its turn ends", async () => {
    const { store, bot, room, thread, close, turnEnds } = await freshRoom();
    close.closeRoomThreadAtTurnEnd(thread, bot);
    store.appendMessage(thread, { role: "user", kind: "text", text: "Hold on, one more" });
    turnEnds();
    expect(store.groupTaskByThread(room.id, thread)?.closedAt).toBeUndefined();
  });
});
