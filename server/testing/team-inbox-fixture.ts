// A small Team Cloud in memory for the inbox's unit tests: Acme's Owner Philipp, a member Marco, an Admin Ada and Carl,
// who left; a shared bot Scout that Philipp owns, each person's own Chief, a bot of Marco's, and a room.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { botOwner } from "../../shared/bot-owner.ts";
import type { Notification } from "../../shared/notification.ts";
import { audienceMember, memberAudience, roomAudience, type Audience } from "../audience.ts";
import { createTeamMessages, type TeamMessagesDeps } from "../host/team-messages.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message, StoreChange } from "../store.ts";

export const key = (email: string) => personKey({ id: "", email });
export const PHILIPP = { email: "philipp@acme.test", role: "owner" as const, name: "Philipp" };
export const MARCO = { email: "marco@acme.test", role: "member" as const, name: "Marco" };
export const ADA = { email: "ada@acme.test", role: "admin" as const, name: "Ada" };
export const CARL = { email: "carl@acme.test", role: "member" as const, name: "Carl", leftAt: 5 };

export const session = (email: string) => ({ kind: "session", scopes: ["client"], session: { id: email, email } }) as unknown as RequestAuth;

type Task = { threadId: string; title: string; archivedAt?: number; activity?: string; routineRunId?: string };
type Bot = Partial<Omit<BotRecord, "tasks">> & { id: string; name: string; threadId: string; tasks: Task[] };

export function teamInbox(options: { team?: boolean; representative?: TeamMessagesDeps["inbox"]["representative"]; noChiefFor?: string[]; handed?: Record<string, string> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-team-inbox-"));
  const listeners = new Set<(change: StoreChange) => void>();
  const emit = (change: StoreChange) => { for (const listener of listeners) listener(change); };
  const threads = new Map<string, Message[]>();
  const audiences = new Map<string, Audience>([
    ["philipp-private", memberAudience(key(PHILIPP.email))], ["marco-private", memberAudience(key(MARCO.email))], ["room-thread", roomAudience("room")],
  ]);
  const starters = new Map<string, string>();
  const bots: Bot[] = [
    { id: "scout", name: "Scout", color: "blue", threadId: "scout-main", createdBy: PHILIPP.email, tasks: [
      { threadId: "scout-main", title: "Scout" }, { threadId: "philipp-private", title: "Philipp and Scout" }, { threadId: "marco-private", title: "Marco and Scout" },
    ] },
    { id: "marcos-chief", name: "Marco's Chief", color: "green", threadId: "mc-main", chiefOfStaff: true, reportsTo: MARCO.email, tasks: [{ threadId: "mc-main", title: "Marco's Chief" }] },
    { id: "philipps-chief", name: "Philipp's Chief", color: "red", threadId: "pc-main", chiefOfStaff: true, reportsTo: PHILIPP.email, tasks: [{ threadId: "pc-main", title: "Philipp's Chief" }] },
    { id: "reporter", name: "Reporter", title: "Writes the reports", color: "teal", threadId: "rep-main", reportsTo: MARCO.email, activity: "working",
      tasks: [{ threadId: "rep-main", title: "Reporter" }, { threadId: "rep-q4", title: "Q4 report", activity: "working" }] },
  ].filter((bot) => !(options.noChiefFor ?? []).includes(bot.reportsTo ?? "") || !bot.chiefOfStaff) as Bot[];
  const groups = [{ id: "room", name: "Launch", threadId: "room-thread", memberIds: ["scout"] }];
  const roomPeople = new Set([key(PHILIPP.email), key(MARCO.email)]);
  let made = 0, ids = 0, clock = 0;
  const tick = () => (clock = Math.max(Date.now(), clock + 1));
  const unread: string[] = [];
  const store = {
    bots,
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    botByThread: (threadId: string) => bots.find((bot) => bot.tasks.some((task) => task.threadId === threadId)) ?? null,
    groupByThread: (threadId: string) => groups.find((group) => group.threadId === threadId),
    tasks: (botId: string) => bots.find((bot) => bot.id === botId)?.tasks ?? [],
    taskByThread: (botId: string, threadId: string) => bots.find((bot) => bot.id === botId)?.tasks.find((task) => task.threadId === threadId),
    createTask: (botId: string, title: string) => {
      const task = { threadId: `made-${++made}`, title };
      bots.find((bot) => bot.id === botId)!.tasks.push(task);
      return task;
    },
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: tick(), ...message } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      emit({ type: "message", threadId, message: full });
      return full;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
      const rows = threads.get(threadId)!;
      const index = rows.findIndex((row) => row.id === id);
      rows[index] = { ...rows[index]!, ...patch };
      emit({ type: "message.patch", threadId, message: rows[index]! });
      return rows[index]!;
    },
    patchTask: (botId: string, threadId: string, patch: { title?: string; unread?: boolean }) => {
      const task = bots.find((bot) => bot.id === botId)?.tasks.find((one) => one.threadId === threadId);
      if (task && patch.title) task.title = patch.title;
      if (patch.unread) unread.push(threadId);
      return null;
    },
    patchGroup: (id: string) => { unread.push(id); return null; },
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    activePath: (threadId: string) => threads.get(threadId) ?? [],
    onChange: (listener: (change: StoreChange) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const people: Array<{ email: string; role: "owner" | "admin" | "member"; name: string; leftAt?: number }> = [PHILIPP, MARCO, ADA, CARL];
  const notified: Notification[] = [];
  const continued: Array<{ botId: string; threadId: string; text: string; from: { botId: string; name: string }; relay: Message["relay"] }> = [];
  const audienceOf = (threadId: string): Audience => audiences.get(threadId) ?? (starters.has(threadId) ? memberAudience(starters.get(threadId)!) : "team");
  const changed: string[] = [];
  const make = () => createTeamMessages({
    team: options.team === false ? null : { id: "team-acme", name: "Acme" },
    dataDir,
    now: tick,
    store: store as never,
    people: { everyone: () => people.map(({ email, role, leftAt }) => ({ email, role, firstSeenAt: 1, lastSeenAt: 1, ...(leftAt ? { leftAt } : {}) })) },
    personName: (person) => people.find((one) => key(one.email) === person)?.name,
    audienceOf,
    starters: { get: (threadId) => starters.get(threadId), set: (threadId, person) => { starters.set(threadId, person); } },
    sees: (person) => ({
      bot: () => true,
      thread: (threadId) => {
        const audience = audienceOf(threadId);
        if (audience === "team") return true;
        if (audience.startsWith("room:")) return person.role !== "member" || roomPeople.has(key(person.email));
        return audience === memberAudience(key(person.email));
      },
    }),
    notify: (notification) => { notified.push(notification); },
    inbox: {
      askedPerson: (botId, threadId) => {
        const member = audienceMember(audienceOf(threadId));
        if (member) return member;
        const owner = botId ? botOwner(store.bot(botId) ?? {}) : null;
        return owner ? key(owner) : null;
      },
      continueTurn: (botId, threadId, text, from, relay) => { continued.push({ botId, threadId, text, from, relay }); },
      changed: (threadId) => { changed.push(threadId); },
      handedFrom: (threadId) => options.handed?.[threadId] ?? null,
      notes: (botId) => ({ reporter: "The Q4 report draft is due on Nov 3.", scout: "Philipp's notes.", "marcos-mausbot": "Notes only Marco sees." })[botId] ?? "",
      ...(options.representative ? { representative: options.representative } : {}),
    },
  });
  let team = make();
  const lines = (threadId: string) => threads.get(threadId) ?? [];
  const said = (threadId: string, text: string, who: { email: string; name: string }, extra: Partial<Message> = {}) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, sender: { name: who.name, id: key(who.email) }, ...extra });
  const inboxOf = (who: { email: string }) => team.inbox.home(key(who.email))!;
  return {
    get team() { return team; },
    store, lines, notified, continued, changed, unread, said, bots, audiences, starters, dataDir, inboxOf,
    /** The server starts again: the inbox reads back what it kept, over the same conversations. */
    restart: () => { team.stop(); team = make(); },
    deleteThread: (threadId: string) => { threads.delete(threadId); emit({ type: "thread.deleted", threadId }); },
    close: () => { team.stop(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
