import { describe, expect, it } from "vitest";
import type { Notification } from "../../shared/notification.ts";
import type { Audience } from "../audience.ts";
import type { AwayEvent } from "./team-away.ts";
import type { Message } from "../store.ts";
import type { Delivery, Item } from "./person-inbox.ts";
import { createTeamAwayEvents } from "./team-away-events.ts";

const MAYA = "p_mayamayamayamayamayama", BEN = "p_benbenbenbenbenbenbenb";
const audiences: Record<string, Audience> = { shared: "team", room: "room:g1", mayas: `member:${MAYA}`, bens: `member:${BEN}`, inbox: `member:${MAYA}` };

function world(messages: Record<string, Partial<Message>[]> = {}) {
  const events: AwayEvent[] = [];
  let unseen: { id: string }[] = [{ id: "line-1" }];
  const events_ = createTeamAwayEvents({
    audienceOf: (threadId) => audiences[threadId] ?? "team",
    store: {
      bot: (id: string) => (id === "scout" ? { id, name: "Scout" } : id === "sales" ? { id, name: "Sales" } : undefined),
      groupByThread: (threadId: string) => (threadId === "room" ? { id: "g1", name: "Q3 launch" } : undefined),
      activePath: (threadId: string) => (messages[threadId] ?? []) as Message[],
      messagesFor: (threadId: string) => (messages[threadId] ?? []) as Message[],
    } as never,
    unseen: () => unseen,
    noticed: (event) => events.push(event),
  });
  return { events, ...events_, setUnseen: (next: { id: string }[]) => { unseen = next; } };
}

const item = (over: Partial<Item> = {}): Item => ({ id: "line-1", person: MAYA, botId: "mausbot", threadId: "inbox", kind: "message", from: "Ben", text: "secret words", at: 1, ...over });
const delivery = (over: Partial<Delivery>): Delivery => ({ kind: "message", from: { name: "Ben", email: "ben@example.com" }, text: "the words: never sent", title: "Ben mentioned you in Scout", notify: "mention", ...over });
const plain = (event: AwayEvent) => ({ ...event, still: undefined });

describe("what of a Team Cloud is worth an away email", () => {
  it("a teammate's mention in a shared chat: who and where, never the words", () => {
    const { events, delivered, setUnseen } = world();
    delivered(item(), delivery({ origin: { botId: "scout", threadId: "shared", messageId: "m1" } }));
    expect(events.map(plain)).toEqual([{ person: MAYA, about: "inbox:line-1", thread: "shared", still: undefined, item: { kind: "mention", who: "Ben", place: "Scout" } }]);
    expect(JSON.stringify(events)).not.toContain("words");
    expect(events[0]!.still!()).toBe(true);
    setUnseen([]);
    expect(events[0]!.still!()).toBe(false);
  });

  it("a mention in a group chat names the group chat", () => {
    const { events, delivered } = world();
    delivered(item(), delivery({ origin: { botId: "scout", threadId: "room", groupId: "g1" } }));
    expect(events[0]!.item).toEqual({ kind: "mention", who: "Ben", place: "Q3 launch" });
  });

  it("from someone's private chat: only that a teammate wrote, no bot, no place; a bot's is not emailed", () => {
    const { events, delivered } = world();
    delivered(item(), delivery({ origin: { botId: "scout", threadId: "bens" } }));
    delivered(item({ id: "line-2" }), delivery({ from: { name: "Scout", botId: "scout" }, origin: { botId: "scout", threadId: "bens" } }));
    expect(events.map((event) => event.item)).toEqual([{ kind: "mention", who: "Ben", private: true }]);
  });

  it("a question routed to the bot's owner names the bot; one from a private chat names nothing", () => {
    const { events, delivered } = world();
    const card = { requestId: "r1", question: "Which plan?" } as never;
    delivered(item(), delivery({ kind: "ask", from: { name: "Sales", botId: "sales" }, notify: "question", card, origin: { botId: "sales", threadId: "shared" } }));
    delivered(item({ id: "line-2" }), delivery({ kind: "ask", from: { name: "Sales", botId: "sales" }, notify: "approval", card: { requestId: "r2" } as never, origin: { botId: "sales", threadId: "mayas" } }));
    expect(events.map((event) => [event.about, event.item])).toEqual([
      ["ask:shared:r1", { kind: "waiting", who: "Sales" }],
      ["ask:mayas:r2", { kind: "waiting", private: true }],
    ]);
  });

  it("a routine's report and failure, once per conversation; an assistant's answer and other news are not emailed", () => {
    const { events, delivered } = world();
    delivered(item(), delivery({ kind: "result", from: { name: "Scout", botId: "scout" }, notify: "done", origin: { botId: "scout", threadId: "shared" } }));
    delivered(item({ id: "line-2" }), delivery({ kind: "notice", from: { name: "Scout", botId: "scout" }, notify: "routine-failed", origin: { botId: "scout", threadId: "mayas" } }));
    delivered(item({ id: "line-3" }), delivery({ assistant: true, origin: { botId: "scout", threadId: "shared" } }));
    delivered(item({ id: "line-4" }), delivery({ kind: "notice", from: { name: "Scout", botId: "scout" }, notify: "incident", origin: { botId: "scout", threadId: "shared" } }));
    expect(events.map((event) => [event.conversation, event.item])).toEqual([
      ["shared", { kind: "finished", who: "Scout", routine: true }],
      ["mayas", { kind: "failed", private: true, routine: true }],
    ]);
  });

  const note = (over: Partial<Notification>): Notification => ({ kind: "question", botId: "scout", botName: "Scout", threadId: "mayas", title: "Scout asks", body: "Which plan, the blue one?", ...over });

  it("a question in the person's own private chat: a bot waits, nothing more, while its card is open", () => {
    const card = { id: "c", role: "bot", kind: "options", card: { requestId: "r9", title: "Which plan?", options: [] } } as unknown as Partial<Message>;
    const { events, notified } = world({ mayas: [card] });
    notified(note({}), note({}));
    expect(events.map(plain)).toEqual([{ person: MAYA, about: "ask:mayas:r9", thread: "mayas", still: undefined, item: { kind: "waiting", private: true } }]);
    expect(events[0]!.still!()).toBe(true);
    (card.card as { answered?: string }).answered = "blue";
    expect(events[0]!.still!()).toBe(false);
  });

  it("work asked for in a shared place finished or failed: told to whoever asked last", () => {
    const asked = { shared: [{ id: "u1", role: "user", sender: { id: BEN, name: "Ben" } }], room: [{ id: "u2", role: "user", sender: { id: MAYA, name: "Maya" } }] } as Record<string, Partial<Message>[]>;
    const { events, notified } = world(asked);
    notified(note({ kind: "done", threadId: "shared" }), note({ kind: "done", threadId: "shared" }));
    notified(note({ kind: "turn-failed", threadId: "room", groupId: "g1" }), note({ kind: "turn-failed", threadId: "room", groupId: "g1" }));
    expect(events.map((event) => [event.person, event.about, event.conversation, event.item])).toEqual([
      [BEN, "done:shared:u1", "shared", { kind: "finished", who: "Scout" }],
      [MAYA, "turn-failed:room:u2", "room", { kind: "failed", who: "Scout", place: "Q3 launch" }],
    ]);
  });

  it("nothing from a private chat's finished work, a routine's own run, or what the inbox already took", () => {
    const { events, notified } = world({ mayas: [{ id: "u1", role: "user", sender: { id: MAYA, name: "Maya" } }] });
    notified(note({ kind: "done" }), note({ kind: "done" }));
    notified(note({ kind: "done", threadId: "shared" }), note({ kind: "done", threadId: "shared" }), { routine: true });
    notified(note({}), { ...note({}), forPerson: MAYA });
    notified(note({}), null);
    expect(events).toEqual([]);
  });
});
