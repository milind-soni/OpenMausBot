import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { WireGroup } from "../../shared/wire.ts";
import { personKey } from "../person-key.ts";
import { createPersonRooms, createRoomReads, roomUnreadFor, stillHeldUnread } from "./room-reads.ts";

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

it("holds a conversation marked unread with it open until a reply follows the message newest then", () => {
  expect(stillHeldUnread(path, "m3")).toBe(true);
  expect(stillHeldUnread([...path, { id: "m4", role: "bot", kind: "activity" }], "m3"), "a tool line is no reply").toBe(true);
  expect(stillHeldUnread([...path, { id: "m4", role: "bot" }], "m3")).toBe(false);
  expect(stillHeldUnread(path, undefined), "never marked").toBe(false);
  expect(stillHeldUnread(path, "edited away"), "its message left the path").toBe(false);
  expect(stillHeldUnread([], ""), "marked with no message yet").toBe(true);
  expect(stillHeldUnread(path, ""), "a reply came after an empty conversation was marked").toBe(false);
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
  reads.read("room", "p_ada", "fork-reply", "fork");
  expect(reads.readUpTo("room", "p_ada")).toBe("m2");
  expect(reads.readUpTo("room", "p_ben")).toBeUndefined();
  expect(createRoomReads(dir).readUpTo("room", "p_ada")).toBe("m2");
  expect(createRoomReads(dir).readUpTo("room", "p_ada", "fork")).toBe("fork-reply");
  reads.forgetRoom("room");
  expect(createRoomReads(dir).readUpTo("room", "p_ada")).toBeUndefined();
  expect(createRoomReads(dir).readUpTo("room", "p_ada", "fork")).toBeUndefined();
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

it("keeps a person's background fork unread after they read the room's main conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-fork-reads-"));
  const reads = createRoomReads(dir);
  const paths = new Map([
    ["main", [{ id: "main-user", role: "user" }, { id: "main-reply", role: "bot" }]],
    ["fork", [{ id: "fork-user", role: "user" }, { id: "fork-reply", role: "bot" }]],
  ]);
  const group = { id: "room", threadId: "main", unread: true, tasks: [
    { threadId: "main", unread: true }, { threadId: "fork", unread: true },
  ] } as WireGroup;
  const rooms = createPersonRooms({ reads, store: () => ({
    activePath: (threadId) => paths.get(threadId) ?? [], messagesFor: (threadId) => paths.get(threadId) ?? [], botByThread: () => null,
  }), newestMessageId: (threadId) => paths.get(threadId)?.at(-1)?.id,
  shared: () => false, wireBot: () => null, publicGroupState: () => group, broadcast: () => {},
  });
  reads.read("room", "ada", "main-reply", "main");
  expect(rooms.groupForPerson(group, "ada")).toMatchObject({ unread: true, tasks: [
    { threadId: "main", unread: false }, { threadId: "fork", unread: true },
  ] });
  reads.read("room", "ada", "fork-reply", "fork");
  expect(rooms.groupForPerson(group, "ada").unread).toBe(false);
  expect(rooms.groupForPerson(group, "ben").unread).toBe(true);
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
  expect(rooms.taskForPerson(main, adaKey)).toEqual({ threadId: "main", unread: true, lastReadMessageId: "m3", heldUnread: "m4" });
  expect(rooms.personHeldUnread!(ada, "main"), "held for Ada while nothing newer came").toBe(true);
  expect(rooms.taskForPerson(main, cleoKey), "Cleo's copy carries no mark of Ada's").not.toHaveProperty("heldUnread");
  thread.push({ id: "m5", role: "bot" });
  expect(rooms.personHeldUnread!(ada, "main"), "a newer reply ends it").toBe(false);
  expect(rooms.taskForPerson(main, adaKey)).not.toHaveProperty("heldUnread");
  thread.pop();
  expect(rooms.personMarkThread!(ada, "main", false)).toBe(true);
  expect(rooms.personHeldUnread!(ada, "main"), "reading it ends it").toBe(false);
  expect(rooms.personHeldUnread!(ada, "mine"), "a private chat keeps the conversation's own mark").toBeNull();
  const own = { threadId: "mine", unread: true, lastReadMessageId: "m2" };
  expect(rooms.personMarkThread!(ada, "mine", false), "a private chat keeps its one mark").toBe(false);
  expect(rooms.taskForPerson(own, adaKey)).toBe(own);
});

it("forgets a person's other marks of their own with their read lines", () => {
  const forgotten: string[] = [];
  const reads = createRoomReads(mkdtempSync(join(tmpdir(), "room-reads-")), (person) => forgotten.push(person));
  reads.forgetPerson("p_ada");
  expect(forgotten, "even with no read line of theirs").toEqual(["p_ada"]);
});

it("shows a person's mark on a shared chat with no reply before its newest one as unread, until a reply follows", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-reads-"));
  const thread: Array<{ id: string; role: string }> = [];
  const rooms = createPersonRooms({
    reads: createRoomReads(dir),
    store: () => ({ activePath: () => thread, messagesFor: () => thread, botByThread: () => ({ id: "scout" }) }),
    shared: (threadId) => threadId === "main",
    wireBot: (id) => ({ id }),
    newestMessageId: () => thread.at(-1)?.id,
    publicGroupState: (room) => room as never,
    broadcast: () => {},
  });
  const ada = { kind: "session", session: { id: "s1", email: "ada@acme.test" } } as never;
  const adaKey = personKey({ id: "", email: "ada@acme.test" }), cleoKey = personKey({ id: "", email: "cleo@acme.test" });
  const main = { threadId: "main", unread: false };
  rooms.personMarkThread!(ada, "main", true);
  expect(rooms.taskForPerson(main, adaKey), "an empty chat").toEqual({ threadId: "main", unread: true, heldUnread: "" });
  expect(rooms.taskForPerson(main, cleoKey).unread, "nobody else's").toBe(false);
  thread.push({ id: "m1", role: "bot" });
  expect(rooms.taskForPerson(main, adaKey), "its first reply ends the mark, and with nothing read yet the chat's own mark shows")
    .toEqual({ threadId: "main", unread: false });
  rooms.personMarkThread!(ada, "main", true);
  expect(rooms.taskForPerson(main, adaKey), "marked with only that first reply in it").toEqual({ threadId: "main", unread: true, heldUnread: "m1" });
});

type Line = { id: string; role: string; kind?: string; at: number };
/** A shared chat whose path order (`path`) and write order (`written`) can differ, as an inserted reply makes them. */
function sharedChat(path: Line[], written: Line[] = [...path]) {
  const rooms = createPersonRooms({
    reads: createRoomReads(mkdtempSync(join(tmpdir(), "room-reads-"))),
    store: () => ({ activePath: () => path, messagesFor: () => written, botByThread: () => ({ id: "scout" }) }),
    shared: (threadId) => threadId === "main",
    wireBot: (id) => ({ id }),
    newestMessageId: () => path.at(-1)?.id,
    publicGroupState: (room) => room as never,
    broadcast: () => {},
  });
  const insert = (index: number, line: Line) => { path.splice(index, 0, line); written.push(line); };
  return { rooms, insert };
}
const session = (email: string) => ({ kind: "session", session: { id: email, email } }) as never;

it("ends each person's mark on a shared chat when a reply is inserted before the message they marked, keeping their lines apart", () => {
  const { rooms, insert } = sharedChat([{ id: "m1", role: "user", at: 1 }, { id: "m2", role: "bot", at: 2 }, { id: "m3", role: "user", at: 3 }, { id: "m4", role: "bot", at: 4 }]);
  const ada = session("ada@acme.test"), ben = session("ben@acme.test"), cleo = session("cleo@acme.test");
  const key = (email: string) => personKey({ id: "", email });
  const main = { threadId: "main", unread: false };
  rooms.personMarkThread!(ada, "main", true);
  rooms.personMarkThread!(ben, "main", true);
  rooms.personMarkThread!(cleo, "main", false);
  insert(2, { id: "late", role: "bot", at: 5 });
  expect(rooms.personHeldUnread!(ada, "main"), "a reply written after the mark, placed before the marked message").toBe(false);
  expect(rooms.personHeldUnread!(ben, "main")).toBe(false);
  expect(rooms.taskForPerson(main, key("ada@acme.test")), "still unread, read up to where Ada was")
    .toEqual({ threadId: "main", unread: true, lastReadMessageId: "m3" });
  expect(rooms.taskForPerson(main, key("cleo@acme.test")), "Cleo's line is her own").toEqual({ threadId: "main", unread: false, lastReadMessageId: "m4" });
  rooms.personMarkThread!(ada, "main", true);
  expect(rooms.personHeldUnread!(ada, "main"), "marking again right after it holds").toBe(true);
  expect(rooms.personHeldUnread!(ben, "main"), "without bringing back Ben's").toBe(false);
  insert(3, { id: "trail", role: "bot", kind: "activity", at: 6 });
  expect(rooms.personHeldUnread!(ada, "main"), "an inserted working line is no reply").toBe(true);
});

it("ends a mark on a shared chat by when a reply was written, not by its clock", () => {
  const ada = session("ada@acme.test");
  const sameTime = sharedChat([{ id: "a", role: "bot", at: 10 }, { id: "b", role: "bot", at: 20 }]);
  sameTime.rooms.personMarkThread!(ada, "main", true);
  sameTime.insert(1, { id: "c", role: "bot", at: 20 });
  expect(sameTime.rooms.personHeldUnread!(ada, "main"), "inserted mid-history in the marked message's millisecond").toBe(false);
  const clockBack = sharedChat([{ id: "a", role: "bot", at: 10 }, { id: "b", role: "bot", at: 20 }]);
  clockBack.rooms.personMarkThread!(ada, "main", true);
  clockBack.insert(2, { id: "c", role: "bot", at: -80 });
  expect(clockBack.rooms.personHeldUnread!(ada, "main"), "added at the end after the clock went back").toBe(false);
  const untimed = sharedChat([{ id: "a", role: "bot", at: 10 }, { id: "b", role: "user", at: 20 }]);
  untimed.rooms.personMarkThread!(ada, "main", true);
  untimed.insert(0, { id: "old", role: "bot", at: 0 });
  expect(untimed.rooms.personHeldUnread!(ada, "main"), "any reply written after the mark, even one dated long before").toBe(false);
});
