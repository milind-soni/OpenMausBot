import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addSentChats, type SentConversation } from "./cloud-chat-merge.ts";
import { chatHeads, chatIds, chatPage, cloudSendChatsRoute, CHAT_PAGE_BYTES, CHAT_ROWS_PAGE, CHATS_BODY_MAX, inOrder, threadRowsAfter, verifyChats, VERIFY_IDS } from "./cloud-send-chats.ts";
import { DATA_DIR } from "./config.ts";
import { deleteThread, threadHeads } from "./message-db.ts";
import { Store, type Message } from "./store.ts";

const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
const say = (store: Store, threadId: string, text: string, at: number) => store.appendMessage(threadId, { role: "user", kind: "text", text, at });
const answer = (store: Store, threadId: string, text: string, at: number) => store.appendMessage(threadId, { role: "bot", kind: "text", text, at });
const ids = (rows: readonly Message[]) => rows.map((row) => row.id);

type Cursor = { after: number; id: string | null };
/** One send of a conversation as main makes it: this computer's pages from the cursor, each page one sent conversation.
 * `sent`: a cursor was there before the page went (main moves it as soon as My Cloud takes a page). */
function pagesOf(store: Store, threadId: string, cursor: Cursor = { after: 0, id: null }): { pages: SentConversation[]; cursor: Cursor } {
  const pages: SentConversation[] = [];
  for (let asked = 0; asked < 100; asked++) {
    const page = chatPage({ store, dataDir: DATA_DIR }, threadId, cursor.after, cursor.id)!;
    const owner = "room" in page ? { room: page.room, roomInfo: page.roomInfo } : { bot: page.bot };
    if (page.rows.length) pages.push({ ...owner, threadId, task: page.task, rows: page.rows, leaf: page.leaf, sent: cursor.after > 0 });
    cursor = { after: page.last, id: page.lastId };
    if (!page.more || !page.lastId) return { pages, cursor };
  }
  throw new Error("the pages never end");
}
/** What this computer shows of a conversation, before its rows are cleared so My Cloud can be played in the same database. */
function shown(store: Store, threadId: string) {
  return { path: ids(store.activePath(threadId)), leaf: store.activeLeaf(threadId) };
}
/** My Cloud: this computer's bots (same ids), none of its rows. */
function cloudOf(threadIds: readonly string[]): Store {
  for (const threadId of threadIds) deleteThread(threadId);
  return fresh();
}
const take = (cloud: Store, pages: readonly SentConversation[]) => addSentChats(cloud, DATA_DIR, "/elsewhere/.openmausbot", pages, { busy: () => false });

describe("this computer's chats, by row", () => {
  it("lists each bot conversation's newest row, and hands the rows after a point a page at a time", () => {
    const store = fresh();
    const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
    const lines = Array.from({ length: CHAT_ROWS_PAGE + 5 }, (_, i) => say(store, bot.threadId, `line ${i}`, 10 + i));
    const head = chatHeads(store.bots).find((entry) => entry.threadId === bot.threadId)!;
    expect(head).toMatchObject({ bot: bot.id, lastId: lines.at(-1)!.id, busy: false });

    const first = threadRowsAfter(bot.threadId, 0, null, CHAT_ROWS_PAGE);
    expect(first).toMatchObject({ more: true, restarted: false, lastId: lines[CHAT_ROWS_PAGE - 1]!.id });
    expect(first.rows).toHaveLength(CHAT_ROWS_PAGE);
    const second = threadRowsAfter(bot.threadId, first.last, first.lastId, CHAT_ROWS_PAGE);
    expect(second.rows.map((row) => row.id)).toEqual(lines.slice(CHAT_ROWS_PAGE).map((row) => row.id));
    expect(second).toMatchObject({ more: false, last: head.last, lastId: head.lastId });
    // Caught up: nothing, and the same point back.
    expect(threadRowsAfter(bot.threadId, head.last, head.lastId, CHAT_ROWS_PAGE)).toMatchObject({ rows: [], last: head.last, lastId: head.lastId, more: false });
  });

  it("keeps a page under its size by stored bytes, never under one row, and sends a row over 1 MB whole, alone", () => {
    const store = fresh();
    const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
    const big = "x".repeat(CHAT_PAGE_BYTES / 3);
    const lines = Array.from({ length: 5 }, (_, i) => say(store, bot.threadId, `${i} ${big}`, 10 + i));
    const first = threadRowsAfter(bot.threadId, 0, null, CHAT_ROWS_PAGE, CHAT_PAGE_BYTES);
    expect(first.rows.map((row) => row.id)).toEqual(lines.slice(0, 2).map((row) => row.id));
    expect(first.more).toBe(true);
    const text = `${"y".repeat(CHAT_PAGE_BYTES * 2)}語`;
    const huge = say(store, bot.threadId, text, 99);
    const alone = threadRowsAfter(bot.threadId, threadHeads().get(bot.threadId)!.last - 1, lines.at(-1)!.id, CHAT_ROWS_PAGE, CHAT_PAGE_BYTES);
    expect(alone.rows.map((row) => row.id)).toEqual([huge.id]);
    const page = chatPage({ store, dataDir: "/data" } as never, bot.threadId, threadHeads().get(bot.threadId)!.last - 1, lines.at(-1)!.id)!;
    expect(page.rows.map((row) => row.text), "never shortened").toEqual([text]);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(CHATS_BODY_MAX);
  });

  it("counts a page's size in UTF-8 bytes, as My Cloud's body limit does", () => {
    const store = fresh();
    const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
    // About 0.9 MB each in UTF-8, a third of that in characters: two fit in a page by bytes, six would by characters.
    const lines = Array.from({ length: 6 }, (_, i) => say(store, bot.threadId, "語".repeat(300_000) + i, 10 + i));
    const page = threadRowsAfter(bot.threadId, 0, null, CHAT_ROWS_PAGE, CHAT_PAGE_BYTES);
    expect(page.rows.map((row) => row.id)).toEqual(lines.slice(0, 2).map((row) => row.id));
    expect(page.more).toBe(true);
  });

  it("starts a conversation over when the row it stopped at is gone, since that row's number can be given out again", () => {
    const store = fresh();
    const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
    say(store, bot.threadId, "one", 1);
    const page = threadRowsAfter(bot.threadId, 0, null, CHAT_ROWS_PAGE);
    deleteThread(bot.threadId);
    const again = say(store, bot.threadId, "two", 2);
    const after = threadRowsAfter(bot.threadId, page.last, page.lastId, CHAT_ROWS_PAGE);
    expect(after).toMatchObject({ restarted: true, more: false });
    expect(after.rows.map((row) => row.id)).toEqual([again.id]);
    expect(threadHeads().get(bot.threadId)?.lastId).toBe(again.id);
  });
});

describe("on My Cloud", () => {
  it("skips a conversation whose bot is not there or is answering in it, never brings back one removed there, and adds the rest once", () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const row = (id: string, at: number, parentId: string | null): Message => ({ id, at, parentId, role: "user", kind: "text", text: id });
    const none = addSentChats(store, DATA_DIR, "/elsewhere/.openmausbot", [
      { bot: "not-here", threadId: "t-nobody", task: null, rows: [row("x1", 1, null)], leaf: "x1", sent: false },
      { bot: ava.id, threadId: ava.threadId, task: null, rows: [row("a1", 1, null)], leaf: "a1", sent: false },
      { bot: ava.id, threadId: "t-gone", task: { threadId: "t-gone", title: "Gone", createdAt: 1, resumeCursors: {} }, rows: [row("g2", 5, "g1")], leaf: "g2", sent: true },
    ], { busy: (threadId) => threadId === ava.threadId });
    expect(none).toEqual({ conversations: 0, messages: 0, accepted: [], waiting: ["t-nobody", ava.threadId], removed: ["t-gone"] });
    expect(store.messagesFor(ava.threadId)).toEqual([]);
    expect(store.messagesFor("t-gone")).toEqual([]);

    // A conversation My Cloud lacks and never had arrives whole, with only what a conversation is.
    const added = addSentChats(store, DATA_DIR, "/elsewhere/.openmausbot", [
      { bot: ava.id, threadId: "t-new", task: { threadId: "t-new", title: "Plans", createdAt: 1, resumeCursors: { claude: "session" }, busy: true } as never,
        rows: [row("n1", 1, null), row("n2", 2, "n1")], leaf: "n2", sent: false },
      { bot: ava.id, threadId: ava.threadId, task: null, rows: [row("a1", 3, null)], leaf: "a1", sent: false },
    ], { busy: () => false });
    expect(added).toEqual({ conversations: 1, messages: 3, accepted: ["t-new", ava.threadId], waiting: [], removed: [] });
    expect(store.bot(ava.id)!.tasks!.find((task) => task.threadId === "t-new")).toMatchObject({ title: "Plans", resumeCursors: {} });
    // The next rows of both, alone: added after what is there, nothing twice.
    const next = addSentChats(store, DATA_DIR, "/elsewhere/.openmausbot", [
      { bot: ava.id, threadId: "t-new", task: null, rows: [row("n3", 4, "n2")], leaf: "n3", sent: true },
      { bot: ava.id, threadId: ava.threadId, task: null, rows: [row("a1", 3, null), row("a2", 5, "a1")], leaf: "a2", sent: true },
    ], { busy: () => false });
    expect(next).toMatchObject({ messages: 2, accepted: ["t-new", ava.threadId] });
    expect(store.messagesFor("t-new").map((entry) => entry.id)).toEqual(["n1", "n2", "n3"]);
    expect(store.messagesFor(ava.threadId).map((entry) => entry.id)).toEqual(["a1", "a2"]);
  });
});

describe("a conversation sent in pages", () => {
  it("into an empty conversation, three pages and more come out as one conversation My Cloud shows whole, and its bot reads whole", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    for (let i = 0; i < 2 * CHAT_ROWS_PAGE + 5; i++) (i % 2 ? answer : say)(here, ava.threadId, `line ${i}`, 10 + i);
    const task = here.createTask(ava.id, "Plans", false)!;
    for (let i = 0; i < 2 * CHAT_ROWS_PAGE + 1; i++) (i % 2 ? answer : say)(here, task.threadId, `plan ${i}`, 10 + i);
    const main = pagesOf(here, ava.threadId), plans = pagesOf(here, task.threadId);
    expect([main.pages.length, plans.pages.length]).toEqual([3, 3]);
    const want = { main: shown(here, ava.threadId), plans: shown(here, task.threadId) };
    const cloud = cloudOf([ava.threadId, task.threadId]);
    cloud.patchBot(ava.id, { tasks: [] });
    for (const page of [...main.pages, ...plans.pages]) expect(take(cloud, [page]).accepted).toEqual([page.threadId]);
    expect(shown(cloud, ava.threadId)).toEqual(want.main);
    expect(shown(cloud, task.threadId)).toEqual(want.plans);
    expect(want.main.path).toHaveLength(2 * CHAT_ROWS_PAGE + 5);
    expect(cloud.bot(ava.id)!.tasks!.map((entry) => entry.threadId)).toEqual([task.threadId]);
  });

  it("all of a conversation's pages in one request come out the same", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    for (let i = 0; i < 2 * CHAT_ROWS_PAGE + 5; i++) say(here, ava.threadId, `line ${i}`, 10 + i);
    const { pages } = pagesOf(here, ava.threadId);
    const want = shown(here, ava.threadId);
    const cloud = cloudOf([ava.threadId]);
    expect(take(cloud, pages.map((page) => ({ ...page, sent: false }))).accepted).toEqual(pages.map(() => ava.threadId));
    expect(shown(cloud, ava.threadId)).toEqual(want);
  });

  it("into a conversation My Cloud has from a Copy, three pages go on from the Copy's last message, and My Cloud's own replies stay in place", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    const lines = Array.from({ length: 3 * CHAT_ROWS_PAGE - 50 }, (_, i) => (i % 2 ? answer : say)(here, ava.threadId, `line ${i}`, 1_000 + i * 10));
    const copied = here.activePath(ava.threadId).slice(0, 200);
    const { pages } = pagesOf(here, ava.threadId);
    expect(pages).toHaveLength(3);
    const want = shown(here, ava.threadId);
    const cloud = cloudOf([ava.threadId]);
    cloud.importTranscript(ava.threadId, copied.map((row) => ({ ...row })), copied.at(-1)!.id);
    // Asked on the phone after the Copy, before this computer's next line.
    const phone = say(cloud, ava.threadId, "From my phone", 1_000 + 199 * 10 + 5);
    for (const page of pages) expect(take(cloud, [page]).accepted).toEqual([ava.threadId]);
    const path = ids(cloud.activePath(ava.threadId));
    expect(path).toHaveLength(lines.length + 1);
    expect(path.filter((id) => id !== phone.id)).toEqual(want.path);
    expect(path.indexOf(phone.id)).toBe(200);
    expect(cloud.activeLeaf(ava.threadId)).toBe(want.leaf);
  });

  it("a later send of two pages and more goes on from the first, and My Cloud's conversation ends at this computer's last message", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    for (let i = 0; i < 10; i++) say(here, ava.threadId, `early ${i}`, 10 + i);
    const first = pagesOf(here, ava.threadId);
    for (let i = 0; i < CHAT_ROWS_PAGE + 5; i++) (i % 2 ? answer : say)(here, ava.threadId, `late ${i}`, 100 + i);
    const later = pagesOf(here, ava.threadId, first.cursor);
    expect(later.pages).toHaveLength(2);
    const want = shown(here, ava.threadId);
    const cloud = cloudOf([ava.threadId]);
    for (const page of [...first.pages, ...later.pages]) take(cloud, [page]);
    expect(cloud.activePath(ava.threadId).at(-1)!.id).toBe(want.leaf);
    expect(shown(cloud, ava.threadId)).toEqual(want);
    expect(want.path).toHaveLength(CHAT_ROWS_PAGE + 15);
  });

  it("a context summary that ends a send is added, so what follows it in the next send is shown after it", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    const early = Array.from({ length: 10 }, (_, i) => say(here, ava.threadId, `x${i}`, 10 + i));
    const first = pagesOf(here, ava.threadId);
    const summary = here.appendMessage(ava.threadId, { role: "bot", kind: "compaction", text: "Summary", at: 50,
      compaction: { summary: "Ten lines about x.", firstKeptId: early[8]!.id, foldedThroughId: early[7]!.id, tokensBefore: 900, by: "person" } });
    const second = pagesOf(here, ava.threadId, first.cursor);
    const late = [say(here, ava.threadId, "y0", 60), answer(here, ava.threadId, "y1", 61)];
    const third = pagesOf(here, ava.threadId, second.cursor);
    // A summary at the end of a page, with what follows it on the next page.
    const paged = here.createBot({ name: "Bo" }, { seedMessages: false });
    for (let i = 0; i < CHAT_ROWS_PAGE - 1; i++) say(here, paged.threadId, `p${i}`, 10 + i);
    here.appendMessage(paged.threadId, { role: "bot", kind: "compaction", text: "Summary", at: 400,
      compaction: { summary: "Many lines.", firstKeptId: "x", foldedThroughId: "y", tokensBefore: 900, by: "harness" } });
    for (let i = 0; i < 5; i++) say(here, paged.threadId, `q${i}`, 500 + i);
    const boundary = pagesOf(here, paged.threadId);
    expect(boundary.pages[0]!.rows.at(-1)!.kind).toBe("compaction");
    const want = { ava: shown(here, ava.threadId), bo: shown(here, paged.threadId) };
    const cloud = cloudOf([ava.threadId, paged.threadId]);
    for (const page of [...first.pages, ...second.pages, ...third.pages, ...boundary.pages]) take(cloud, [page]);
    expect(shown(cloud, ava.threadId)).toEqual(want.ava);
    expect(want.ava.path).toEqual([...ids(early), summary.id, ...ids(late)]);
    expect(shown(cloud, paged.threadId)).toEqual(want.bo);
  });

  it("a page never ends between a row and a row above it that was stored after it, so My Cloud never loses the thread", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    for (let i = 0; i < CHAT_ROWS_PAGE - 2; i++) say(here, ava.threadId, `line ${i}`, 10 + i);
    const anchor = answer(here, ava.threadId, "Done, here is the screen.", 400);
    const next = say(here, ava.threadId, "Thanks, now the next one", 401);
    // The turn's last screen frame lands after the person's next line, and goes above it.
    const frame = here.insertMessageAfter(ava.threadId, anchor.id, { role: "bot", kind: "screen", png: "iVBORw0KGgo=", mime: "image/png" });
    for (let i = 0; i < 5; i++) say(here, ava.threadId, `after ${i}`, 500 + i);
    expect(ids(here.activePath(ava.threadId)).slice(CHAT_ROWS_PAGE - 2, CHAT_ROWS_PAGE + 1)).toEqual([anchor.id, frame.id, next.id]);
    const { pages } = pagesOf(here, ava.threadId);
    expect(pages[0]!.rows.map((row) => row.id)).not.toContain(next.id);
    const want = shown(here, ava.threadId);
    const cloud = cloudOf([ava.threadId]);
    for (const page of pages) take(cloud, [page]);
    expect(shown(cloud, ava.threadId)).toEqual(want);
  });

  it("a page that would hold only a row whose row above was stored after it reaches that row, however big that makes it", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    say(here, ava.threadId, "Take a screenshot", 1);
    const anchor = answer(here, ava.threadId, "Done.", 2);
    const next = say(here, ava.threadId, "Thanks", 3);
    const big = answer(here, ava.threadId, "z".repeat(CHAT_PAGE_BYTES + 1), 4);
    const frame = here.insertMessageAfter(ava.threadId, anchor.id, { role: "bot", kind: "screen", png: "iVBORw0KGgo=", mime: "image/png" });
    const first = chatPage({ store: here, dataDir: DATA_DIR }, ava.threadId, 0, null)!;
    expect(ids(first.rows)).toEqual(ids(here.messagesFor(ava.threadId)).slice(0, 2));
    const second = chatPage({ store: here, dataDir: DATA_DIR }, ava.threadId, first.last, first.lastId)!;
    expect(ids(second.rows)).toEqual([next.id, big.id, frame.id]);
    expect(second).toMatchObject({ more: false, leaf: big.id });
    const { pages } = pagesOf(here, ava.threadId);
    const want = shown(here, ava.threadId);
    const cloud = cloudOf([ava.threadId]);
    for (const page of pages) take(cloud, [page]);
    expect(shown(cloud, ava.threadId)).toEqual(want);
  });
});

describe("POST /api/cloud-send/chats", () => {
  const post = async (body: unknown) => {
    let answered: { status: number; body: any } | undefined;
    const store = fresh();
    const handled = await cloudSendChatsRoute({ store, dataDir: DATA_DIR }, {
      req: {} as never, res: { setHeader() {} } as never, url: new URL("http://127.0.0.1/api/cloud-send/chats"), path: "/api/cloud-send/chats", method: "POST", auth: {} as never,
      json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never, readBody: (async () => body) as never,
    });
    expect(handled).toBe(true);
    return { store, answered: answered! };
  };

  it("a room's thread waits while a bot answers in the room", async () => {
    let answered: any;
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const room = store.createGroup("Busy", [ava.id]);
    store.patchGroup(room.id, { busyBotId: ava.id });
    await cloudSendChatsRoute({ store, dataDir: DATA_DIR }, {
      req: {} as never, res: { setHeader() {} } as never, url: new URL("http://127.0.0.1/api/cloud-send/chats"), path: "/api/cloud-send/chats", method: "POST", auth: {} as never,
      json: ((_res: unknown, _status: number, value: unknown) => { answered = value; }) as never,
      readBody: (async () => ({ v: 1, dataDir: "/x", conversations: [{ room: room.id, roomInfo: { name: "Busy", memberIds: [ava.id], bulletin: "" }, threadId: room.threadId,
        task: { threadId: room.threadId, title: "Untitled", createdAt: 1 }, rows: [{ id: "r1", at: 1, parentId: null, role: "user", kind: "text", text: "hi" }], leaf: "r1", sent: false }] })) as never,
    });
    expect(answered).toMatchObject({ accepted: [], waiting: [room.threadId] });
  });

  it("adds a conversation it never had though its rows are older than this server's last Copy from another computer", async () => {
    const owner = fresh().createBot({ name: "Ledger" }, { seedMessages: false });
    mkdirSync(join(DATA_DIR, ".backups"), { recursive: true });
    writeFileSync(join(DATA_DIR, ".backups", "last-restore.json"), JSON.stringify({ restored: true, id: "3f0c2a8e-1b2c-4d3e-8f4a-5b6c7d8e9f00",
      summary: { createdAt: "2026-10-01T09:00:00.000Z" } }), { mode: 0o600 });
    const september = Date.parse("2026-09-15T10:00:00.000Z");
    const { store, answered } = await post({ v: 1, dataDir: "/work-pc/.openmausbot", conversations: [{ bot: owner.id, threadId: "t-sept", sent: false,
      task: { threadId: "t-sept", title: "September close", createdAt: september },
      rows: [{ id: "s1", at: september, parentId: null, role: "user", kind: "text", text: "Close September" }], leaf: "s1" }] });
    expect(answered).toEqual({ status: 200, body: { conversations: 1, messages: 1, accepted: ["t-sept"], waiting: [], removed: [] } });
    expect(store.bot(owner.id)!.tasks!.map((task) => task.threadId)).toContain("t-sept");
    expect(ids(store.activePath("t-sept"))).toEqual(["s1"]);
  });
});

describe("a room's chats", () => {
  it("are listed with the bots' conversations, every thread of a room, a bot answering in it included; bot-to-bot channels are not", () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const room = store.createGroup("Launch", [ava.id]);
    const pricing = store.createGroupTask(room.id, "Pricing", false)!;
    const channel = store.createGroup("Ava and Bo", [ava.id], true);
    for (const threadId of [ava.threadId, room.threadId, pricing.threadId, channel.threadId]) say(store, threadId, "hello", 1);
    store.patchGroup(room.id, { busyBotId: ava.id });
    const listed = chatHeads(store.bots, store.groups).map(({ bot, room: owner, threadId, busy }) => ({ owner: bot ?? owner, threadId, busy }));
    expect(listed.filter((entry) => entry.owner !== ava.id)).toEqual(expect.arrayContaining([
      { owner: room.id, threadId: room.threadId, busy: true }, { owner: room.id, threadId: pricing.threadId, busy: true }]));
    expect(listed.some((entry) => entry.threadId === channel.threadId)).toBe(false);
  });

  it("make the room on My Cloud under this computer's ids, with each thread whole, three pages and more included", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    const bo = here.createBot({ name: "Bo" }, { seedMessages: false });
    const room = here.createGroup("Launch", [ava.id, bo.id], false, "Work", { bulletin: "Ship on Friday.", defaultResponder: { kind: "mentions" }, completed: true });
    here.patchGroupTask(room.id, room.threadId, { title: "Plan", pinned: true });
    const pricing = here.createGroupTask(room.id, "Pricing", false)!;
    for (let i = 0; i < 2 * CHAT_ROWS_PAGE + 5; i++) (i % 2 ? answer : say)(here, room.threadId, `plan ${i}`, 10 + i);
    for (let i = 0; i < 4; i++) say(here, pricing.threadId, `price ${i}`, 10 + i);
    const plan = pagesOf(here, room.threadId), prices = pagesOf(here, pricing.threadId);
    expect(plan.pages.length).toBeGreaterThanOrEqual(3);
    const want = { plan: shown(here, room.threadId), prices: shown(here, pricing.threadId) };
    const cloud = cloudOf([room.threadId, pricing.threadId]);
    cloud.deleteGroup(room.id);
    cloud.deleteBot(bo.id);
    for (const page of [...plan.pages, ...prices.pages]) expect(take(cloud, [page]).accepted).toEqual([page.threadId]);
    const made = cloud.group(room.id)!;
    expect(made).toMatchObject({ name: "Launch", memberIds: [ava.id], bulletin: "Ship on Friday.", section: "Work", defaultResponder: { kind: "mentions" } });
    expect(made.tasks!.map((task) => [task.threadId, task.title, Boolean(task.pinned)]).sort()).toEqual([[pricing.threadId, "Pricing", false], [room.threadId, "Plan", true]].sort());
    expect(shown(cloud, room.threadId)).toEqual(want.plan);
    expect(shown(cloud, pricing.threadId)).toEqual(want.prices);
  });

  it("never make again a room removed on My Cloud, nor a thread of it, and wait while none of its bots is there or one is answering", () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const room = store.createGroup("Ops", [ava.id]);
    const row = (id: string): Message => ({ id, at: 1, parentId: null, role: "user", kind: "text", text: id });
    const info = { name: "Gone", memberIds: [ava.id], bulletin: "" };
    const answered = addSentChats(store, DATA_DIR, "/elsewhere/.openmausbot", [
      { room: "room-gone", roomInfo: info, threadId: "t-room-gone", task: { threadId: "t-room-gone", title: "Gone", createdAt: 1 } as never, rows: [row("g1")], leaf: "g1", sent: true },
      { room: room.id, roomInfo: info, threadId: "t-thread-gone", task: { threadId: "t-thread-gone", title: "Old", createdAt: 1 } as never, rows: [row("o1")], leaf: "o1", sent: true },
      { room: "room-lonely", roomInfo: { ...info, memberIds: ["not-here"] }, threadId: "t-lonely", task: { threadId: "t-lonely", title: "Hi", createdAt: 1 } as never, rows: [row("l1")], leaf: "l1", sent: false },
      { room: room.id, roomInfo: info, threadId: room.threadId, task: { threadId: room.threadId, title: "Untitled", createdAt: 1 } as never, rows: [row("b1")], leaf: "b1", sent: false },
    ], { busy: (threadId) => threadId === room.threadId });
    expect(answered).toMatchObject({ accepted: [], removed: ["t-room-gone", "t-thread-gone"], waiting: ["t-lonely", room.threadId] });
    expect([store.group("room-gone"), store.group("room-lonely")]).toEqual([undefined, undefined]);
    expect(store.group(room.id)!.tasks!.map((task) => task.threadId)).toEqual([room.threadId]);
  });
});

describe("a room nobody wrote in yet", () => {
  const listed = async (store: Store) => {
    let answered: any;
    await cloudSendChatsRoute({ store, dataDir: DATA_DIR }, {
      req: {} as never, res: { setHeader() {} } as never, url: new URL("http://127.0.0.1/api/cloud-send/chats"), path: "/api/cloud-send/chats", method: "GET", auth: {} as never,
      json: ((_res: unknown, _status: number, value: unknown) => { answered = value; }) as never, readBody: (async () => null) as never,
    });
    return answered;
  };

  it("is listed with its members beside the conversations, as no conversation of it is; a room with a row, and a bot-to-bot channel, are not", async () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const bo = store.createBot({ name: "Bo" }, { seedMessages: false });
    const quiet = store.createGroup("Quiet", [ava.id, bo.id]);
    const spoken = store.createGroup("Spoken", [ava.id]);
    const later = store.createGroupTask(spoken.id, "Later", false)!;
    say(store, later.threadId, "hello", 1);
    const channel = store.createGroup("Ava and Bo", [ava.id, bo.id], true);
    const answer = await listed(store);
    const ours = new Set([quiet.id, spoken.id, channel.id]);
    expect(answer.rooms.filter((room: { room: string }) => ours.has(room.room))).toEqual([{ room: quiet.id, threadId: quiet.threadId, members: [ava.id, bo.id] }]);
    expect(answer.conversations.filter((head: { room?: string }) => head.room && ours.has(head.room)).map((head: { threadId: string }) => head.threadId)).toEqual([later.threadId]);
  });

  it("is made on My Cloud from its thread sent with no rows, under this computer's ids, and taken", () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    const quiet = here.createGroup("Quiet", [ava.id], false, "Work", { bulletin: "Weekly.", defaultResponder: { kind: "mentions" }, completed: true });
    const page = chatPage({ store: here, dataDir: DATA_DIR }, quiet.threadId, 0, null)!;
    expect(page).toMatchObject({ rows: [], lastId: null, more: false });
    const cloud = cloudOf([]);
    cloud.deleteGroup(quiet.id);
    const owner = "room" in page ? { room: page.room, roomInfo: page.roomInfo } : {};
    expect(take(cloud, [{ ...owner, threadId: quiet.threadId, task: page.task, rows: [], leaf: null, sent: false }]).accepted).toEqual([quiet.threadId]);
    expect(cloud.group(quiet.id)).toMatchObject({ name: "Quiet", threadId: quiet.threadId, memberIds: [ava.id], bulletin: "Weekly.", section: "Work" });
  });
});

describe("a room My Cloud takes", () => {
  it("goes as My Cloud takes a room, so one named after a long calendar call never refuses the conversations sent beside it", async () => {
    const here = fresh();
    const ava = here.createBot({ name: "Ava" }, { seedMessages: false });
    const call = here.createGroup(`Weekly sync about ${"the launch, ".repeat(20)}`.trim(), [ava.id]);
    say(here, call.threadId, "@everyone the agenda", 1);
    say(here, ava.threadId, "hello", 2);
    const roomPage = pagesOf(here, call.threadId).pages, botPage = pagesOf(here, ava.threadId).pages;
    expect(call.name.length).toBeGreaterThan(100);
    expect(roomPage[0]!.roomInfo!.name).toBe(call.name.slice(0, 100));
    const cloud = cloudOf([call.threadId, ava.threadId]);
    cloud.deleteGroup(call.id);
    let answered: any;
    await cloudSendChatsRoute({ store: cloud, dataDir: DATA_DIR }, {
      req: {} as never, res: { setHeader() {} } as never, url: new URL("http://127.0.0.1/api/cloud-send/chats"), path: "/api/cloud-send/chats", method: "POST", auth: {} as never,
      json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never,
      readBody: (async () => ({ v: 1, dataDir: "/elsewhere/.openmausbot", conversations: [...roomPage, ...botPage] })) as never,
    });
    expect(answered).toMatchObject({ status: 200, body: { accepted: [call.threadId, ava.threadId] } });
    expect(cloud.group(call.id)!.name).toBe(call.name.slice(0, 100));
  });
});

describe("over the owner's own session", () => {
  const OWNER = { person: "p_cloudowner00000000000", name: "Amit" };
  /** `ownerSession`: the request is My Cloud's owner's own session; the route asks its deps whose session it is. */
  const route = (store: Store, body: unknown, ownerSession: boolean) => {
    let answered: any;
    return cloudSendChatsRoute({ store, dataDir: DATA_DIR, owner: (auth) => (auth as { owner?: boolean }).owner ? OWNER : null }, {
      req: {} as never, res: { setHeader() {} } as never, url: new URL("http://127.0.0.1/api/cloud-send/chats"), path: "/api/cloud-send/chats", method: "POST",
      auth: { owner: ownerSession } as never, json: ((_res: unknown, _status: number, value: unknown) => { answered = value; }) as never, readBody: (async () => body) as never,
    }).then(() => answered);
  };
  const sent = (bot: string, threadId: string, rows: Message[], extra: Record<string, unknown> = {}) =>
    ({ v: 1, dataDir: "/desk/.openmausbot", conversations: [{ bot, threadId, task: null, rows, leaf: rows.at(-1)!.id, sent: false, ...extra }] });
  const typed = (id: string, at: number, parentId: string | null): Message => ({ id, at, parentId, role: "user", kind: "text", text: id });

  it("a bot conversation's lines its owner wrote, and the cards it answered, arrive as My Cloud's owner's", async () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const card: Message = { id: "c1", at: 2, parentId: "u1", role: "bot", kind: "options", card: { title: "Run it?", subtitle: "", options: ["Allow"], requestId: "q1", answered: "Allow", answeredBy: { kind: "loopback" } } };
    const peer: Message = { id: "p1", at: 3, parentId: "c1", role: "user", kind: "text", text: "From Chief", peerAsk: { botId: "chief", name: "Chief" } };
    expect((await route(store, sent(ava.id, ava.threadId, [typed("u1", 1, null), card, peer]), true)).accepted).toEqual([ava.threadId]);
    const there = new Map(store.messagesFor(ava.threadId).map((row) => [row.id, row]));
    expect(there.get("u1")!.sender).toEqual({ name: "Amit", id: OWNER.person });
    expect(there.get("c1")!.card!.answeredBy).toEqual({ kind: "session", name: "Amit", person: OWNER.person });
    expect(there.get("p1")!.sender, "a peer's ask is never the owner's").toBeUndefined();
  });

  it("any other session's send, and a room's lines, arrive as they were", async () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    await route(store, sent(ava.id, ava.threadId, [typed("g1", 1, null)]), false);
    expect(store.messagesFor(ava.threadId)[0]!.sender).toBeUndefined();
    const room = store.createGroup("Launch", [ava.id]);
    await route(store, { v: 1, dataDir: "/desk/.openmausbot", conversations: [{ room: room.id, threadId: room.threadId, task: null, rows: [typed("r1", 1, null)], leaf: "r1", sent: false }] }, true);
    expect(store.messagesFor(room.threadId).map((row) => [row.id, row.sender])).toEqual([["r1", undefined]]);
  });

  /** The move's ask for the rows My Cloud already held, by id: `stamped` collects what the route says changed. */
  const own = (store: Store, body: unknown, ownerSession: boolean, stamped: string[] = []) => {
    let answered: { status: number; body: any } | undefined;
    return cloudSendChatsRoute({ store, dataDir: DATA_DIR, owner: (auth) => (auth as { owner?: boolean }).owner ? OWNER : null, stamped: (threadId) => { stamped.push(threadId); } }, {
      req: {} as never, res: { setHeader() {} } as never, url: new URL("http://127.0.0.1/api/cloud-send/chats/owner"), path: "/api/cloud-send/chats/owner", method: "POST",
      auth: { owner: ownerSession } as never, json: ((_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }) as never, readBody: (async () => body) as never,
    }).then(() => answered!);
  };

  it("lines My Cloud already held from that computer, named by id, become the owner's as arriving ones do; nobody else's, no automation's and no room's ever", async () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    // As an earlier send or a Bring left them on My Cloud: every line names nobody.
    const mine = say(store, ava.threadId, "Book the flight.", 1);
    const peer = store.appendMessage(ava.threadId, { role: "user", kind: "text", text: "From Chief", peerAsk: { botId: "chief", name: "Chief" }, at: 2 });
    const routine = say(store, ava.threadId, "[Routine \"Inbox\" — do this now:]\nRead my inbox.", 3);
    const card = store.appendMessage(ava.threadId, { role: "bot", kind: "options", at: 4,
      card: { title: "Run it?", subtitle: "", options: ["Allow"], requestId: "q1", answered: "Allow", answeredBy: { kind: "loopback" } } });
    const notNamed = say(store, ava.threadId, "Typed on My Cloud by nobody known.", 5);
    const room = store.createGroup("Launch", [ava.id]);
    const roomLine = say(store, room.threadId, "In the room.", 6);
    const body = { v: 1, conversations: [{ threadId: ava.threadId, ids: [mine.id, peer.id, routine.id, card.id] }, { threadId: room.threadId, ids: [roomLine.id] }] };
    const stamped: string[] = [];
    expect((await own(store, body, false, stamped)).status, "only My Cloud's owner's own session may say").toBe(403);
    expect(store.messagesFor(ava.threadId).map((row) => row.sender ?? null)).toEqual([null, null, null, null, null]);

    expect(await own(store, body, true, stamped)).toEqual({ status: 200, body: { v: 1, stamped: 2 } });
    const there = new Map(store.messagesFor(ava.threadId).map((row) => [row.id, row]));
    expect(there.get(mine.id)!.sender).toEqual({ name: "Amit", id: OWNER.person });
    expect(there.get(card.id)!.card!.answeredBy).toEqual({ kind: "session", name: "Amit", person: OWNER.person });
    expect([peer, routine, notNamed].map((row) => there.get(row.id)!.sender ?? null)).toEqual([null, null, null]);
    expect(store.messagesFor(room.threadId).map((row) => row.sender ?? null)).toEqual([null]);
    expect(stamped, "the conversation whose lines became the owner's").toEqual([ava.threadId]);
    expect(await own(store, body, true, stamped), "a second ask changes nothing").toEqual({ status: 200, body: { v: 1, stamped: 0 } });
    expect(stamped).toEqual([ava.threadId]);
  });

  it("My Cloud takes at most 5,000 of a conversation's row ids, and 10,000 in all, in one ask", async () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const many = (count: number) => Array.from({ length: count }, (_, i) => `row-${i}`);
    expect((await own(store, { v: 1, conversations: [{ threadId: ava.threadId, ids: many(VERIFY_IDS) }, { threadId: ava.threadId, ids: many(VERIFY_IDS) }] }, true)).status).toBe(200);
    expect((await own(store, { v: 1, conversations: [{ threadId: ava.threadId, ids: many(VERIFY_IDS + 1) }] }, true)).status).toBe(400);
    expect((await own(store, { v: 1, conversations: Array.from({ length: 3 }, () => ({ threadId: ava.threadId, ids: many(VERIFY_IDS) })) }, true)).status).toBe(400);
  });

  it("My Cloud's chats check counts the owner's lines it holds that do not carry the owner yet", async () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const rows = [say(store, ava.threadId, "Book the flight.", 1), answer(store, ava.threadId, "Booked.", 2)];
    const room = store.createGroup("Launch", [ava.id]);
    const roomLine = say(store, room.threadId, "In the room.", 3);
    const ask = () => verifyChats(store, [{ threadId: ava.threadId, ids: ids(rows) }, { threadId: room.threadId, ids: [roomLine.id] }]).map((entry) => entry.unstamped);
    expect(ask()).toEqual([1, 0]);
    await own(store, { v: 1, conversations: [{ threadId: ava.threadId, ids: ids(rows) }] }, true);
    expect(ask()).toEqual([0, 0]);
  });
});

describe("checking a move's chats", () => {
  it("this computer hands its row ids and its visible path, a chunk at a time", () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    // One transaction: five thousand appends, each its own, take over 40 s on Windows.
    const rows: Message[] = Array.from({ length: VERIFY_IDS + 3 }, (_, i) => ({ id: `row-${i}`, parentId: i ? `row-${i - 1}` : null, role: "user", kind: "text", text: `line ${i}`, at: 10 + i }));
    store.importTranscript(ava.threadId, rows, rows.at(-1)!.id);
    const first = chatIds({ store, dataDir: DATA_DIR }, ava.threadId, 0)!;
    expect({ ids: first.ids.length, path: first.path.length, more: first.more, leaf: first.leaf }).toEqual({ ids: VERIFY_IDS, path: VERIFY_IDS, more: true, leaf: rows.at(-1)!.id });
    const second = chatIds({ store, dataDir: DATA_DIR }, ava.threadId, VERIFY_IDS)!;
    expect([second.ids, second.path, second.more]).toEqual([rows.slice(VERIFY_IDS).map((row) => row.id), rows.slice(VERIFY_IDS).map((row) => row.id), false]);
    expect(chatIds({ store, dataDir: DATA_DIR }, "t-nobody", 0)).toBeNull();
  });

  it("a path holds when it appears in order inside My Cloud's, chunk after chunk; out of order, or a row off the path, it does not", () => {
    const cloud = ["a", "b", "x", "c", "d", "y", "e"];
    expect(inOrder(cloud, null, ["a", "b", "c"])).toEqual({ holds: true, at: "c" });
    expect(inOrder(cloud, "c", ["d", "e"])).toEqual({ holds: true, at: "e" });
    expect(inOrder(cloud, null, ["a", "c", "b"])).toEqual({ holds: false, at: "c" });
    expect(inOrder(cloud, null, ["a", "q"])).toEqual({ holds: false, at: "a" });
    expect(inOrder(cloud, "nope", ["a"])).toEqual({ holds: false, at: null });
  });

  it("My Cloud names the rows it lacks and whether the path holds, with its own leaf and length on the last chunk", () => {
    const store = fresh();
    const ava = store.createBot({ name: "Ava" }, { seedMessages: false });
    const rows = Array.from({ length: 6 }, (_, i) => say(store, ava.threadId, `line ${i}`, 10 + i).id);
    const [checked] = verifyChats(store, [{ threadId: ava.threadId, ids: [...rows, "missing-1"], path: { after: null, ids: rows, last: true } }]);
    expect(checked).toEqual({ threadId: ava.threadId, missing: ["missing-1"], unstamped: 6, path: { holds: true, at: rows.at(-1), leaf: rows.at(-1), length: 6 } });
    const [broken] = verifyChats(store, [{ threadId: ava.threadId, path: { after: null, ids: [rows[0]!, "elsewhere", rows[1]!], last: false } }]);
    expect(broken).toEqual({ threadId: ava.threadId, missing: [], unstamped: 0, path: { holds: false, at: rows[0] } });
  });
});
