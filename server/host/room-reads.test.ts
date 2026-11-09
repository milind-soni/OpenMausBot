import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { createPersonRooms, createRoomReads, roomUnreadFor } from "./room-reads.ts";

const path = [{ id: "m1", role: "user" }, { id: "m2", role: "bot" }, { id: "m3", role: "user" }];

it("is unread for a person only while a bot's line follows where they read up to", () => {
  expect(roomUnreadFor(path, "m2", true)).toBe(false);
  expect(roomUnreadFor(path, "m1", false)).toBe(true);
  expect(roomUnreadFor(path, undefined, true), "never opened: the room's own mark").toBe(true);
});

it("counts only a bot's replies, not its tool or status lines", () => {
  const working = [{ id: "m1", role: "user", kind: "text" }, { id: "m2", role: "bot", kind: "activity" }, { id: "m3", role: "bot", kind: "screen" }];
  expect(roomUnreadFor(working, "m1", true)).toBe(false);
  expect(roomUnreadFor([...working, { id: "m4", role: "bot", kind: "text" }], "m1", false)).toBe(true);
});

it("reads a line no longer on the path as read up to the last message at or before it", () => {
  const timed = [{ id: "m1", role: "user", at: 1 }, { id: "m2", role: "bot", at: 2 }, { id: "m4", role: "bot", at: 4 }];
  expect(roomUnreadFor(timed, "edited", true, () => 3), "only the reply after it is unread").toBe(true);
  expect(roomUnreadFor(timed, "edited", true, () => 5)).toBe(false);
  expect(roomUnreadFor(timed, "gone", true, () => undefined), "a line gone from the room reads as read").toBe(false);
});

it("keeps each person's line apart and across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-reads-"));
  const reads = createRoomReads(dir);
  reads.read("room", "p_ada", "m2");
  expect(reads.readUpTo("room", "p_ada")).toBe("m2");
  expect(reads.readUpTo("room", "p_ben")).toBeUndefined();
  expect(createRoomReads(dir).readUpTo("room", "p_ada")).toBe("m2");
  reads.forgetRoom("room");
  expect(createRoomReads(dir).readUpTo("room", "p_ada")).toBeUndefined();
});

it("forgets a person's lines in every room, and one person's line in one room", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-reads-"));
  const reads = createRoomReads(dir);
  reads.read("a", "p_ada", "m1");
  reads.read("b", "p_ada", "m2");
  reads.read("b", "p_ben", "m3");
  reads.forget("b", "p_ben");
  expect(reads.readUpTo("b", "p_ben")).toBeUndefined();
  reads.forgetPerson("p_ada");
  const reloaded = createRoomReads(dir);
  expect([reloaded.readUpTo("a", "p_ada"), reloaded.readUpTo("b", "p_ada")]).toEqual([undefined, undefined]);
});

it("reads a bot's shared chat per person, leaves a private chat's one mark alone, and marks unread before the newest reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-reads-"));
  const thread = [{ id: "m1", role: "user" }, { id: "m2", role: "bot" }, { id: "m3", role: "user" }, { id: "m4", role: "bot" }];
  const frames: Array<{ person: string }> = [];
  const rooms = createPersonRooms({
    reads: createRoomReads(dir),
    store: () => ({ activePath: () => thread, messagesFor: () => thread, botByThread: () => ({ id: "scout" }) }),
    shared: (threadId) => threadId === "main",
    wireBot: (id) => ({ id }),
    newestMessageId: () => "m4",
    publicGroupState: (room) => room as never,
    broadcast: (_payload, options) => frames.push(options),
  });
  const ada = { kind: "session", session: { id: "s1", email: "ada@acme.test" } } as never;
  const adaKey = personKey({ id: "", email: "ada@acme.test" }), cleoKey = personKey({ id: "", email: "cleo@acme.test" });
  const main = { threadId: "main", unread: true, lastReadMessageId: "m2" };
  expect(rooms.taskForPerson(main, cleoKey), "never read: the chat's own mark, without anyone's read line").toEqual({ threadId: "main", unread: true });
  expect(rooms.personMarkThread!(ada, "main", false)).toBe(true);
  expect(rooms.taskForPerson(main, adaKey)).toEqual({ threadId: "main", unread: false, lastReadMessageId: "m4" });
  expect(rooms.taskForPerson(main, cleoKey).unread).toBe(true);
  expect(frames, "told to Ada's streams alone").toEqual([{ person: adaKey }]);
  expect(rooms.personMarkThread!(ada, "main", true)).toBe(true);
  expect(rooms.taskForPerson(main, adaKey)).toEqual({ threadId: "main", unread: true, lastReadMessageId: "m3" });
  const own = { threadId: "mine", unread: true, lastReadMessageId: "m2" };
  expect(rooms.personMarkThread!(ada, "mine", false), "a private chat keeps its one mark").toBe(false);
  expect(rooms.taskForPerson(own, adaKey)).toBe(own);
});
