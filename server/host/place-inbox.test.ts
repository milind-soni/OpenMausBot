import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Notification } from "../../shared/notification.ts";
import type { PersonWait } from "../../shared/person-wait.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createPlaceInbox, PLACE_INBOX_FILE, PLACE_MESSAGES_HOURLY, placeInboxViewer, type InboxViewer, type OpenCardRow, type PlaceInboxDeps } from "./place-inbox.ts";

const OWNER = { kind: "owner-session" } as unknown as RequestAuth;
const GUEST = { kind: "guest-session" } as unknown as RequestAuth;
const SHELL = { kind: "shell" } as unknown as RequestAuth;
const viewers = new Map<RequestAuth, InboxViewer>([[OWNER, { kind: "owner" }], [GUEST, { kind: "guest", key: "p_guest" }], [SHELL, { kind: "nobody" }]]);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Said = { id: string; at: number; role: string; peerAsk?: boolean; relayed?: boolean; via?: string; text?: string; inbox?: unknown; replyToId?: string };

function setup(over: Partial<PlaceInboxDeps> = {}, dataDir = mkdtempSync(join(tmpdir(), "place-inbox-"))) {
  dirs.push(dataDir);
  let clock = 1_000;
  let serial = 0;
  const said = new Map<string, Said[]>();
  const cards: OpenCardRow[] = [];
  const sent: Notification[] = [];
  const handed = new Map<string, string>();
  const guests = new Map<string, string>();
  const bots: Record<string, { id: string; name: string; threadId: string; color: string; notifications?: boolean }> = {
    eli: { id: "eli", name: "Eli", threadId: "eli-main", color: "blue" }, mira: { id: "mira", name: "Mira", threadId: "mira-main", color: "red" },
  };
  const titles: Record<string, string> = { "eli-main": "Eli", "eli-pricing": "Pricing work", "eli-launch": "Launch work", "guest-chat": "Guest chat" };
  const rooms: Record<string, { id: string; name: string; memberIds: string[] }> = { "room-main": { id: "room", name: "Team room", memberIds: ["eli", "mira"] } };
  const listeners: Array<(change: { type: string; threadId: string }) => void> = [];
  const store = {
    bot: (id: string) => bots[id],
    botByThread: (threadId: string) => (threadId.startsWith("eli") || threadId === "guest-chat" ? bots.eli : threadId.startsWith("mira") ? bots.mira : undefined),
    taskByThread: (_botId: string, threadId: string) => (titles[threadId] ? { threadId, title: titles[threadId] } : undefined),
    groupByThread: (threadId: string) => rooms[threadId],
    appendMessage: (threadId: string, line: Omit<Said, "id" | "at">) => {
      const posted = { ...line, id: `m${++serial}`, at: clock };
      said.set(threadId, [...(said.get(threadId) ?? []), posted]);
      return posted;
    },
    patchTask: () => undefined, patchGroup: () => undefined,
    messagesFor: (threadId: string) => said.get(threadId) ?? [],
    onChange: (listener: (change: { type: string; threadId: string }) => void) => { listeners.push(listener); return () => undefined; },
  };
  const inbox = createPlaceInbox({
    dataDir, store: store as unknown as PlaceInboxDeps["store"], openCards: () => cards,
    viewer: (auth) => viewers.get(auth)!,
    sees: () => true,
    mayAnswer: (auth) => auth === OWNER,
    guestOf: (threadId) => guests.get(threadId) ?? null, guestName: () => "Sam",
    handedBy: (threadId) => handed.get(threadId) ?? null,
    send: (one) => sent.push(one), now: () => clock, ...over,
  });
  const ask = (threadId: string, requestId: string, card: Partial<OptionCardData> = {}, at = clock) => {
    const row = { threadId, id: `card-${requestId}`, at, fromBotId: null, card: JSON.stringify({ requestId, title: "Ask", subtitle: `Ask ${requestId}`, options: ["Yes", "No"], requestType: "question", ...card }) };
    cards.push(row);
    return row;
  };
  return { inbox, store, said, cards, sent, handed, guests, bots, listeners, ask, dataDir, tick: (ms: number) => { clock += ms; } };
}

describe("finished work reaches the inbox once", () => {
  const work = (threadId: string, text = "Pricing page updated.") => ({ botId: "mira", threadId, text });
  const asked = { botId: "eli", threadId: "eli-main" };
  const summary = { kind: "done", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Done", body: "All three pages are live." } as Notification;
  const infoRows = (f: ReturnType<typeof setup>) => f.inbox.view(OWNER).rows.filter((row) => row.tab === "info");

  it("files handed-off work as an unread line, opening its own thread, and sends nothing", () => {
    const f = setup();
    f.inbox.handedResult(work("mira-pricing"), asked);
    expect(infoRows(f)).toMatchObject([{ kind: "result", from: { name: "Mira", botId: "mira" }, workingFor: { name: "Eli" }, text: "Pricing page updated.", unread: true,
      origin: { botId: "mira", threadId: "mira-pricing" } }]);
    expect(f.sent).toEqual([]);
    expect(f.inbox.count(OWNER)).toBe(1);
  });

  it("keeps one row per job: the next teammate's result and then the summary replace it", () => {
    const f = setup();
    f.inbox.handedResult(work("mira-pricing"), asked);
    f.tick(1);
    f.inbox.handedResult(work("mira-launch", "Launch post drafted."), asked);
    expect(infoRows(f).map((row) => row.text)).toEqual(["Launch post drafted."]);
    f.tick(1);
    f.inbox.route(summary, { summary: true });
    expect(infoRows(f)).toMatchObject([{ kind: "result", from: { name: "Eli" }, text: "All three pages are live.", origin: { threadId: "eli-main" } }]);
  });

  it("leaves what the person already read, other jobs and routine reports alone", () => {
    const f = setup();
    f.inbox.handedResult(work("mira-pricing"), asked);
    f.inbox.markRead(OWNER, infoRows(f)[0]!.id);
    f.inbox.handedResult(work("mira-launch", "Second."), { botId: "eli", threadId: "eli-launch" });
    f.inbox.route({ kind: "done", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Done", body: "Weekly report." } as Notification, { routine: true });
    f.tick(1);
    f.inbox.route(summary, { summary: true });
    expect(infoRows(f).map((row) => row.text).sort()).toEqual(["All three pages are live.", "Pricing page updated.", "Second.", "Weekly report."]);
  });

  it("adds no line for a muted bot, an empty reply or a plain turn's done, and a restart keeps the row", () => {
    const f = setup();
    f.bots.mira!.notifications = false;
    f.inbox.handedResult(work("mira-pricing"), asked);
    f.bots.mira!.notifications = true;
    f.inbox.handedResult(work("mira-pricing", "   "), asked);
    f.inbox.route({ kind: "done", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Done", body: "Plain." } as Notification);
    expect(infoRows(f)).toEqual([]);

    f.inbox.handedResult(work("mira-pricing"), asked);
    const reopened = setup({}, f.dataDir);
    expect(infoRows(reopened).map((row) => row.text)).toEqual(["Pricing page updated."]);
    reopened.inbox.route(summary, { summary: true });
    expect(infoRows(reopened).map((row) => row.text)).toEqual(["All three pages are live."]);
  });

  it("files a resumed answer's results notice under the same job, and keeps a guest's work theirs", () => {
    const f = setup();
    f.inbox.route({ kind: "delegation-settled", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Results", body: "Results from Mira" } as Notification, { summary: true });
    f.inbox.route({ kind: "delegation-settled", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Results", body: "ignored" } as Notification);
    expect(infoRows(f).map((row) => row.text)).toEqual(["Results from Mira"]);
    f.guests.set("guest-chat", "p_guest");
    f.inbox.handedResult(work("mira-pricing", "For the guest."), { botId: "eli", threadId: "guest-chat" });
    expect(f.inbox.view(GUEST).rows.map((row) => row.text)).toEqual(["For the guest."]);
    expect(infoRows(f).map((row) => row.text)).toEqual(["Results from Mira"]);
  });
});

describe("who is asking for the inbox", () => {
  const session = { kind: "session", session: { id: "s" } } as unknown as RequestAuth;
  const ownerShell = { kind: "loopback", trust: "owner" } as unknown as RequestAuth;
  const service = { kind: "loopback", trust: "service" } as unknown as RequestAuth;
  const cloud = (personal: boolean, owner: boolean) => ({ personal, owner: () => owner, personOf: () => "p_someone" });

  it("on someone's Cloud: the owner's session is theirs, another is a guest, and loopback is a bot's shell", () => {
    expect(placeInboxViewer(session, cloud(true, true))).toEqual({ kind: "owner" });
    expect(placeInboxViewer(session, cloud(true, false))).toEqual({ kind: "guest", key: "p_someone" });
    expect(placeInboxViewer(ownerShell, cloud(true, false))).toEqual({ kind: "nobody" });
    expect(placeInboxViewer(service, cloud(true, false))).toEqual({ kind: "nobody" });
  });

  it("anywhere else: the desktop's page and a paired device are the person's, and a local service nobody's", () => {
    expect(placeInboxViewer(ownerShell, cloud(false, false))).toEqual({ kind: "owner" });
    expect(placeInboxViewer(session, cloud(false, false))).toEqual({ kind: "owner" });
    expect(placeInboxViewer(service, cloud(false, false))).toEqual({ kind: "nobody" });
  });
});

describe("the inbox of a place that is no team's", () => {
  it("lists what was already waiting, whenever it was asked, with no copy and no notification of its own", () => {
    const f = setup();
    f.ask("eli-main", "old", { tool: "Bash", requestType: "permission" }, 1);
    f.ask("mira-main", "new");
    const { rows, threadId, botId } = f.inbox.view(OWNER);
    expect({ threadId, botId }).toEqual({ threadId: null, botId: null });
    expect(rows.map((row) => [row.id, row.kind, row.tab, row.from.name, row.origin?.threadId, row.card?.requestId])).toEqual([
      ["card-new", "ask", "needs-you", "Mira", "mira-main", "new"],
      ["card-old", "ask", "needs-you", "Eli", "eli-main", "old"],
    ]);
    expect(f.inbox.count(OWNER)).toBe(2);
    expect(f.sent).toEqual([]);
    expect(f.said.size, "nothing was copied anywhere").toBe(0);
  });

  it("drops an ask as soon as its card leaves the open cards, however it was answered", () => {
    const f = setup();
    f.ask("eli-main", "q");
    expect(f.inbox.count(OWNER)).toBe(1);
    f.cards.length = 0;
    expect(f.inbox.count(OWNER)).toBe(0);
    expect(f.inbox.view(OWNER).rows).toEqual([]);
  });

  it("leaves out offers and receipts, and a card somebody already settled", () => {
    const f = setup();
    f.ask("eli-main", "offer", { quotaSwitch: {} as never });
    f.ask("eli-main", "auto", { autoApplied: true });
    f.ask("eli-main", "answered", { answered: "allow" });
    expect(f.inbox.view(OWNER).rows).toEqual([]);
  });

  it("lists a password, a sign-in and an app to connect the person's conversation rests on, each with the chat's own card", () => {
    const waits: Array<PersonWait & { threadId: string }> = [];
    const f = setup({ waiting: () => waits });
    const secret = { target: "custom", label: "Stripe key", description: "", placeholder: "", helpUrl: "", requestKey: "k" };
    const signIn = { url: "https://shop.test", site: "shop.test", place: "browser" };
    const connector = { label: "Gmail", description: "Read mail", resumeKey: "r1" };
    f.said.set("eli-pricing", [
      { id: "pw", at: 10, role: "bot", kind: "secret", secret } as never,
      { id: "si", at: 11, role: "bot", kind: "signin", signIn } as never,
      { id: "co", at: 12, role: "bot", kind: "connector", connector } as never,
    ]);
    f.said.set("guest-chat", [{ id: "gpw", at: 13, role: "bot", kind: "secret", secret } as never]);
    f.guests.set("guest-chat", "p_guest");
    waits.push(
      { kind: "password", messageId: "pw", at: 10, label: "Stripe key", threadId: "eli-pricing" },
      { kind: "sign-in", messageId: "si", at: 11, label: "shop.test", threadId: "eli-pricing" },
      { kind: "connect", messageId: "co", at: 12, label: "Gmail", threadId: "eli-pricing" },
      { kind: "password", messageId: "gpw", at: 13, label: "Stripe key", threadId: "guest-chat" },
    );
    const rows = f.inbox.view(OWNER).rows;
    expect(rows.map((row) => row.id)).toEqual(["co", "si", "pw"]);
    expect(rows.find((row) => row.id === "pw")).toMatchObject({ kind: "ask", tab: "needs-you", text: "Stripe key", secret, origin: { threadId: "eli-pricing", title: "Pricing work", messageId: "pw" } });
    expect(rows.find((row) => row.id === "si")).toMatchObject({ signIn });
    expect(rows.find((row) => row.id === "co")).toMatchObject({ connector });
    expect(f.inbox.count(OWNER)).toBe(3);
    expect(f.inbox.view(GUEST).rows.map((row) => row.id), "a guest's own password is theirs alone").toEqual(["gpw"]);
    expect(f.inbox.view(SHELL).rows).toEqual([]);
    expect(f.inbox.markRead(OWNER, "pw")).toBe(true);
    expect(f.inbox.view(OWNER).rows.find((row) => row.id === "pw")!.unread).toBe(false);
    waits.splice(0, 1);
    expect(f.inbox.view(OWNER).rows.map((row) => row.id), "gone once it no longer waits").toEqual(["co", "si"]);
  });

  it("says who a bot was working for, and which conversation an item came from", () => {
    const f = setup();
    f.handed.set("eli-pricing", "mira");
    f.ask("eli-pricing", "a");
    f.ask("eli-launch", "b");
    const rows = f.inbox.view(OWNER).rows;
    const of = (id: string) => rows.find((row) => row.id === id)!;
    expect(of("card-a")).toMatchObject({ workingFor: { botId: "mira", name: "Mira" }, origin: { threadId: "eli-pricing", title: "Pricing work" } });
    expect(of("card-b").workingFor).toBeUndefined();
    expect(of("card-b").origin).toMatchObject({ threadId: "eli-launch", title: "Launch work" });
  });

  it("gets a bot's message to the person once: one line, one row, one notification, and their words settle it", () => {
    const f = setup();
    const sent = f.inbox.message("eli", "eli-pricing", "The report is ready.");
    expect(sent.status).toBe(200);
    expect(f.sent.map((one) => [one.kind, one.threadId, one.body])).toEqual([["mention", "eli-pricing", "The report is ready."]]);
    const [row] = f.inbox.view(OWNER).rows;
    expect(row).toMatchObject({ kind: "message", tab: "info", unread: true, replies: true, from: { name: "Eli" }, origin: { threadId: "eli-pricing", messageId: row!.id } });
    expect(f.said.get("eli-pricing")!.map((line) => line.id)).toEqual([row!.id]);
    expect(f.inbox.count(OWNER)).toBe(1);

    f.tick(10);
    f.store.appendMessage("eli-pricing", { role: "user", relayed: true });
    expect(f.inbox.view(OWNER).rows[0]!.tab, "a line relayed from another app isn't the person's answer").toBe("info");
    f.store.appendMessage("eli-pricing", { role: "user", via: "api" });
    expect(f.inbox.view(OWNER).rows[0]!.tab, "nor one through the API").toBe("info");
    f.store.appendMessage("eli-pricing", { role: "user", text: "Thanks" });
    expect(f.inbox.view(OWNER).rows[0]!.tab).toBe("done");
    expect(f.inbox.count(OWNER)).toBe(0);
  });

  it("keeps a bot's message from a room open until the person replies to that line or taps Done, since the room's other talk isn't their answer", () => {
    const f = setup();
    const sent = f.inbox.message("eli", "room-main", "The report is ready.");
    expect(sent).toMatchObject({ status: 200, text: expect.stringContaining("posted in this room") });
    const [row] = f.inbox.view(OWNER).rows;
    expect(row).toMatchObject({ kind: "message", tab: "info", unread: true, origin: { threadId: "room-main", groupId: "room", title: "Team room" } });

    f.tick(10);
    f.store.appendMessage("room-main", { role: "user", text: "@Mira can you check the build?" });
    f.store.appendMessage("room-main", { role: "bot", text: "On it." });
    expect(f.inbox.view(OWNER).rows[0]!.tab, "the person talking to others in the room hasn't answered it").toBe("info");
    f.store.appendMessage("room-main", { role: "user", text: "Thanks", replyToId: "some-other-line" });
    expect(f.inbox.view(OWNER).rows[0]!.tab, "nor has a reply to another line").toBe("info");
    f.store.appendMessage("room-main", { role: "user", text: "Thanks", replyToId: row!.id });
    expect(f.inbox.view(OWNER).rows[0]!.tab).toBe("done");

    const other = f.inbox.message("mira", "room-main", "Build is green.");
    expect(other.status).toBe(200);
    const next = f.inbox.view(OWNER).rows.find((one) => one.tab === "info")!;
    f.store.appendMessage("room-main", { role: "user", text: "ok everyone" });
    expect(f.inbox.view(OWNER).rows.find((one) => one.id === next.id)!.tab).toBe("info");
    expect(f.inbox.markDone(OWNER, next.id)).toBe("done");
    expect(f.inbox.view(OWNER).rows.find((one) => one.id === next.id)!.tab).toBe("done");
  });

  it("leaves a room message saved before this rule as it was: the person's next words there still settle it", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "place-inbox-"));
    writeFileSync(join(dataDir, PLACE_INBOX_FILE), `${JSON.stringify({ version: 1, seenAsks: [], lines: [
      { id: "old-line", botId: "eli", threadId: "room-main", groupId: "room", kind: "message", from: "Eli", text: "Earlier news", at: 500 },
    ] })}\n`);
    const f = setup({}, dataDir);
    expect(f.inbox.view(OWNER).rows[0]).toMatchObject({ id: "old-line", tab: "info" });
    f.store.appendMessage("room-main", { role: "user", text: "ok" });
    expect(f.inbox.view(OWNER).rows[0]!.tab).toBe("done");
  });

  it("tells a bot in its own chat that the message is in the Inbox, with no room named", () => {
    const f = setup();
    expect(f.inbox.message("eli", "eli-pricing", "The report is ready.").text).not.toContain("room");
  });

  it("stops a loop of messages from one conversation, and refuses a conversation that isn't the bot's", () => {
    const f = setup();
    for (let index = 0; index < PLACE_MESSAGES_HOURLY; index++) expect(f.inbox.message("eli", "eli-main", `m${index}`).status).toBe(200);
    expect(f.inbox.message("eli", "eli-main", "one more").status).toBe(429);
    expect(f.sent).toHaveLength(PLACE_MESSAGES_HOURLY);
    expect(f.inbox.message("eli", "somewhere-else", "hi").status).toBe(403);
    expect(f.inbox.message("nobody", "eli-main", "hi").status).toBe(403);
  });

  it("counts news until it is read, and a routine's report notifies only through the notification it came with", () => {
    const f = setup();
    const note: Notification = { kind: "done", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Daily digest", body: "3 new leads" };
    expect(f.inbox.route(note, { routine: true })).toBe(note);
    expect(f.sent).toEqual([]);
    const [row] = f.inbox.view(OWNER).rows;
    expect(row).toMatchObject({ kind: "result", text: "3 new leads", tab: "info", unread: true });
    expect(row!.replies).toBeUndefined();
    expect(f.inbox.count(OWNER)).toBe(1);
    expect(f.inbox.markRead(OWNER, row!.id)).toBe(true);
    expect(f.inbox.count(OWNER)).toBe(0);
    expect(f.inbox.markDone(OWNER, row!.id)).toBe("done");
    expect(f.inbox.view(OWNER).rows[0]!.tab).toBe("done");
  });

  it("gives a line to nothing the person is sitting in front of: a chat's own finish and own failure stay out", () => {
    const f = setup();
    f.inbox.route({ kind: "done", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Done", body: "" });
    f.inbox.route({ kind: "turn-failed", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Failed", body: "" });
    f.inbox.route({ kind: "approval", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Approve", body: "" }, { routine: true });
    expect(f.inbox.view(OWNER).rows, "an approval is its card, never a second line").toEqual([]);
    f.inbox.route({ kind: "routine-failed", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Failed", body: "It broke" }, { routine: true });
    f.handed.set("eli-pricing", "mira");
    f.inbox.route({ kind: "turn-failed", botId: "eli", botName: "Eli", threadId: "eli-pricing", title: "Failed", body: "Handed work broke" });
    expect(f.inbox.view(OWNER).rows.map((row) => [row.kind, row.text])).toEqual(expect.arrayContaining([["notice", "It broke"], ["notice", "Handed work broke"]]));
  });

  it("reads an ask as seen without settling it: it still counts, and only its answer closes it", () => {
    const f = setup();
    f.ask("eli-main", "q");
    expect(f.inbox.view(OWNER).rows[0]!.unread).toBe(true);
    expect(f.inbox.markRead(OWNER, "card-q")).toBe(true);
    expect(f.inbox.view(OWNER).rows[0]!.unread).toBe(false);
    expect(f.inbox.count(OWNER)).toBe(1);
    expect(f.inbox.markDone(OWNER, "card-q")).toBe("an ask");
    expect(f.inbox.markRead(OWNER, "not-a-line")).toBe(false);
    expect(f.inbox.markDone(OWNER, "not-a-line")).toBe("unknown");
  });

  it("reads every line and open ask at once for the viewer who has them, answers nothing, and repeats harmlessly", () => {
    const f = setup();
    f.guests.set("guest-chat", "p_guest");
    f.ask("eli-main", "q");
    f.inbox.message("eli", "eli-main", "News");
    f.inbox.message("eli", "guest-chat", "For the guest");
    expect(f.inbox.markAllRead(OWNER)).toBe(2);
    expect(f.inbox.view(OWNER).rows.map((row) => [row.kind, row.tab, row.unread])).toEqual(expect.arrayContaining([["ask", "needs-you", false], ["message", "info", false]]));
    expect(f.inbox.count(OWNER), "the ask still waits on them").toBe(1);
    expect(f.inbox.markDone(OWNER, "card-q")).toBe("an ask");
    expect(f.inbox.view(GUEST).rows.map((row) => row.unread), "the guest's line is not the owner's to read").toEqual([true]);
    expect(f.inbox.markAllRead(OWNER)).toBe(0);
    expect(f.inbox.markAllRead(SHELL)).toBe(0);
    const again = setup({ openCards: () => f.cards, store: f.store as unknown as PlaceInboxDeps["store"] }, f.dataDir);
    expect(again.inbox.view(OWNER).rows.every((row) => !row.unread)).toBe(true);
  });

  it("opening a conversation reads what waited there", () => {
    const f = setup();
    f.inbox.message("eli", "eli-main", "News");
    f.inbox.seen(OWNER, "eli-main");
    expect(f.inbox.view(OWNER).rows[0]!.unread).toBe(false);
  });

  it("forgets a deleted conversation's lines", () => {
    const f = setup();
    f.inbox.message("eli", "eli-main", "News");
    for (const listener of f.listeners) listener({ type: "thread.deleted", threadId: "eli-main" });
    expect(f.inbox.view(OWNER).rows).toEqual([]);
  });

  it("keeps its lines and what was seen across a restart", () => {
    const f = setup();
    f.ask("eli-main", "q");
    f.inbox.markRead(OWNER, "card-q");
    f.inbox.message("eli", "eli-main", "News");
    const again = setup({ openCards: () => f.cards, store: f.store as unknown as PlaceInboxDeps["store"], now: () => 2_000 }, f.dataDir);
    expect(again.inbox.view(OWNER).rows.map((row) => [row.kind, row.unread])).toEqual(expect.arrayContaining([["ask", false], ["message", true]]));
  });

  describe("on a Cloud with a guest", () => {
    function shared() {
      const f = setup();
      f.guests.set("guest-chat", "p_guest");
      f.ask("guest-chat", "theirs");
      f.ask("eli-main", "mine");
      f.inbox.message("eli", "guest-chat", "For the guest");
      f.inbox.message("eli", "eli-main", "For the owner");
      return f;
    }

    it("shows the owner a guest's ask labelled with who asked, since only they can answer it, and never the guest's news", () => {
      const f = shared();
      const rows = f.inbox.view(OWNER).rows;
      expect(rows.find((row) => row.id === "card-theirs")).toMatchObject({ askedBy: { name: "Sam" } });
      expect(rows.find((row) => row.id === "card-mine")!.askedBy).toBeUndefined();
      expect(rows.filter((row) => row.kind === "message").map((row) => row.text)).toEqual(["For the owner"]);
    });

    it("never notifies the owner about a guest's news", () => {
      const f = shared();
      expect(f.sent.map((one) => one.body)).toEqual(["For the owner"]);
    });

    it("shows a guest only their own news, none of the owner's, and no ask they can't answer", () => {
      const f = shared();
      expect(f.inbox.view(GUEST).rows.map((row) => row.text)).toEqual(["For the guest"]);
      expect(f.inbox.count(GUEST)).toBe(1);
      const ownerLine = f.inbox.view(OWNER).rows.find((row) => row.kind === "message")!.id;
      expect(f.inbox.markRead(GUEST, ownerLine), "not theirs to mark").toBe(false);
      expect(f.inbox.markDone(GUEST, ownerLine)).toBe("unknown");
    });

    it("gives nothing to a bot's shell on the Cloud", () => {
      const f = shared();
      expect(f.inbox.view(SHELL).rows).toEqual([]);
      expect(f.inbox.count(SHELL)).toBe(0);
    });
  });
});


describe("the hand-off switch", () => {
  const work = (text = "Pricing page updated.") => ({ botId: "mira", threadId: "mira-pricing", text });
  const asked = { botId: "eli", threadId: "eli-main" };
  const routine = { kind: "done", botId: "eli", botName: "Eli", threadId: "eli-main", title: "Done", body: "Weekly report." } as Notification;
  const failure = (threadId: string) => ({ kind: "turn-failed", botId: "eli", botName: "Eli", threadId, title: "Failed", body: "It stopped." }) as Notification;

  it("keeps a handed-off result out of the list and the count when it is on", () => {
    const f = setup({ delegatedLineHidden: () => true });
    f.inbox.handedResult(work(), asked);
    expect(f.inbox.view(OWNER).rows).toEqual([]);
    expect(f.inbox.count(OWNER)).toBe(0);
  });

  it("files the result as it always did when it is off", () => {
    const f = setup();
    f.inbox.handedResult(work(), asked);
    expect(f.inbox.view(OWNER).rows.map((row) => row.text)).toEqual(["Pricing page updated."]);
    expect(f.inbox.count(OWNER)).toBe(1);
  });

  it("still files the person's own routine report", () => {
    const f = setup({ delegatedLineHidden: () => true });
    f.inbox.route(routine, { routine: true });
    expect(f.inbox.view(OWNER).rows.map((row) => row.text)).toEqual(["Weekly report."]);
    expect(f.inbox.count(OWNER)).toBe(1);
  });

  it("drops a failure in a conversation another bot handed on, and keeps one in the person's own", () => {
    const f = setup({ delegatedLineHidden: () => true });
    f.handed.set("eli-child", "eli");
    f.inbox.route(failure("eli-child"), { routine: true });
    f.inbox.route(failure("eli-main"), { routine: true });
    expect(f.inbox.view(OWNER).rows.map((row) => row.text)).toEqual(["It stopped."]);
  });

  it("keeps a bot's own message to the person, and still says whose work it is", () => {
    const f = setup({ delegatedLineHidden: () => true });
    f.handed.set("mira-main", "eli");
    f.inbox.message("mira", "mira-main", "Hello from Mira.");
    expect(f.inbox.view(OWNER).rows.map((row) => row.text)).toEqual(["Hello from Mira."]);
    expect(f.inbox.view(OWNER).rows[0]!.workingFor).toEqual({ botId: "eli", name: "Eli" });
  });

  it("also leaves out a hand-off line filed before the switch was turned on", () => {
    let hidden = false;
    const f = setup({ delegatedLineHidden: () => hidden });
    f.inbox.handedResult(work(), asked);
    expect(f.inbox.view(OWNER).rows).toHaveLength(1);
    hidden = true;
    expect(f.inbox.view(OWNER).rows).toEqual([]);
    expect(f.inbox.count(OWNER)).toBe(0);
  });
});
