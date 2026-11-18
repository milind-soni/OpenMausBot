import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { CUSTOM_SECRET_TARGET } from "../../shared/credential-request.ts";
import type { Notification } from "../../shared/notification.ts";
import type { SecretRequestCardData } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { Store, type BotRecord } from "../store.ts";
import { createPersonWaits } from "./person-waits.ts";

const SECRET: SecretRequestCardData = { target: CUSTOM_SECRET_TARGET, label: "Mailbox password", description: "desc", reason: "To read the mail.", placeholder: "", helpUrl: "", requestKey: "k", delivery: "ref" };
const SIGN_IN = { url: "https://example.com", site: "example.com", place: "browser", reason: "The dashboard is behind a login." } as const;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const sent: Notification[] = [];
  const known = new Set<string>();
  const waits = createPersonWaits({ store, notify: (notification) => { if (notification) sent.push(notification); }, threadsWithCards: () => [...known] });
  const bot = store.createBot({ name: "Postie" });
  const thread = store.createTask(bot.id, "Work", false)!.threadId;
  const task = () => store.taskByThread(bot.id, thread)!;
  const card = (patch: Record<string, unknown> = {}) => store.appendMessage(thread, { role: "bot", kind: "secret", text: "enter it", secret: { ...SECRET, ...patch } });
  return { store, waits, sent, known, bot, thread, task, card };
}

describe("a conversation resting on the person", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("waits on the person with no turn running, while the card is open", () => {
    const { store, bot, thread, task, card } = fixture();
    const asked = card();
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
    expect(store.bot(bot.id)).toMatchObject({ activity: "waiting-on-you", busy: false });
    store.patchMessage(thread, asked.id, { secret: { ...SECRET, provided: true } });
    expect(task()).toMatchObject({ activity: "idle", busy: false });
    expect(store.bot(bot.id)).toMatchObject({ activity: "idle", busy: false });
  });

  it.each([
    ["saved", { provided: true }],
    ["declined", { dismissed: true }],
    ["replaced", { superseded: true }],
    ["stopped", { stopped: true }],
  ])("stops counting a card that was %s", (_name, settled) => {
    const { store, thread, task, card } = fixture();
    const asked = card();
    store.patchMessage(thread, asked.id, { secret: { ...SECRET, ...settled } });
    expect(task().activity).toBe("idle");
  });

  it("keeps a running turn's own state, and comes back to waiting when it ends", () => {
    const { store, bot, thread, task, card } = fixture();
    store.setTaskActivity(bot.id, thread, "working");
    card();
    expect(task()).toMatchObject({ activity: "working", busy: true });
    store.setTaskActivity(bot.id, thread, "idle");
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
    store.setTaskActivity(bot.id, thread, "working");
    expect(task()).toMatchObject({ activity: "working", busy: true });
    store.setTaskActivity(bot.id, thread, "idle");
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
  });

  it("leaves a card saved during a running turn idle at the turn's end", () => {
    const { store, bot, thread, task, card } = fixture();
    store.setTaskActivity(bot.id, thread, "working");
    const asked = card();
    store.patchMessage(thread, asked.id, { secret: { ...SECRET, provided: true } });
    store.setTaskActivity(bot.id, thread, "idle");
    expect(task()).toMatchObject({ activity: "idle", busy: false });
  });

  it("reads a running turn's approval but does not rest on it", () => {
    const { store, waits, thread, task } = fixture();
    store.appendMessage(thread, { role: "bot", kind: "options", card: { title: "Allow", options: ["Allow"], requestId: "r", tool: "Bash" } as never });
    expect(waits.open(thread)).toMatchObject({ kind: "approval" });
    expect(task().activity).toBe("idle");
  });

  it("lists every conversation resting on the person by its card's kind, newest first, for an inbox", () => {
    const { store, waits, bot, thread, card } = fixture();
    const room = store.createGroup("Launch", [bot.id]);
    const password = card();
    const signIn = store.appendMessage(room.threadId, { role: "bot", kind: "signin", text: "sign in", at: password.at + 1, from: { botId: bot.id, name: bot.name, color: bot.color }, signIn: { ...SIGN_IN } });
    expect(waits.waiting()).toEqual([
      expect.objectContaining({ kind: "sign-in", label: "example.com", threadId: room.threadId, botId: bot.id, messageId: signIn.id }),
      expect.objectContaining({ kind: "password", label: "Mailbox password", threadId: thread, botId: bot.id, messageId: password.id }),
    ]);
    store.patchMessage(thread, password.id, { secret: { ...SECRET, provided: true } });
    expect(waits.waiting().map((wait) => wait.kind)).toEqual(["sign-in"]);
  });

  it("shows a card asked in a room on the room's thread", () => {
    const { store, bot } = fixture();
    const room = store.createGroup("Launch", [bot.id]);
    const asked = store.appendMessage(room.threadId, { role: "bot", kind: "secret", text: "enter it", from: { botId: bot.id, name: bot.name, color: bot.color }, secret: { ...SECRET } });
    expect(store.groupTaskByThread(room.id, room.threadId)?.activity).toBe("waiting-on-you");
    expect(Boolean(store.bot(bot.id)?.busy)).toBe(false);
    store.patchMessage(room.threadId, asked.id, { secret: { ...SECRET, provided: true } });
    expect(store.groupTaskByThread(room.id, room.threadId)?.activity).toBeUndefined();
  });

  it("follows the branch the person is on", () => {
    const { store, thread, task, card } = fixture();
    const before = store.appendMessage(thread, { role: "user", kind: "text", text: "start" });
    const asked = card();
    expect(task().activity).toBe("waiting-on-you");
    const other = store.appendMessage(thread, { role: "user", kind: "text", text: "another way", parentId: before.id });
    store.setActiveLeaf(thread, other.id);
    expect(task().activity).toBe("idle");
    store.setActiveLeaf(thread, asked.id);
    expect(task().activity).toBe("waiting-on-you");
  });

  it("restores what rested on the person after a restart, and leaves a card nobody answered for a week", () => {
    const { store, waits, known, thread, task, bot } = fixture();
    const left = store.createTask(bot.id, "Old work", false)!.threadId;
    store.appendMessage(thread, { role: "bot", kind: "secret", text: "x", secret: { ...SECRET } });
    store.appendMessage(left, { role: "bot", kind: "secret", text: "x", at: Date.now() - 8 * 24 * 60 * 60_000, secret: { ...SECRET } });
    (store.bots as BotRecord[]).forEach((one) => one.tasks?.forEach((row) => { row.activity = "idle"; }));
    known.add(thread).add(left);
    waits.boot();
    expect(task()).toMatchObject({ activity: "waiting-on-you", busy: false });
    expect(store.bot(bot.id)?.busy).toBe(false);
    expect(store.taskByThread(bot.id, left)?.activity).toBe("idle");
  });
});

describe("telling the person", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("says what is needed for a password, once, from the bot that asked", async () => {
    const { sent, card, thread, bot } = fixture();
    card();
    await flush();
    expect(sent).toEqual([expect.objectContaining({ kind: "secret", botId: bot.id, threadId: thread, title: "Postie needs your Mailbox password", body: "To read the mail." })]);
  });

  it("says who and where for a sign-in and an app to connect", async () => {
    const { store, sent, thread } = fixture();
    store.appendMessage(thread, { role: "bot", kind: "signin", text: "sign in", signIn: { ...SIGN_IN } });
    store.appendMessage(thread, { role: "bot", kind: "connector", text: "connect", connector: { slug: "gmail", label: "Gmail", description: "Read mail.", status: "required", resumeKey: "k" } });
    await flush();
    expect(sent.map(({ kind, title, body }) => ({ kind, title, body }))).toEqual([
      { kind: "sign-in", title: "Postie needs you to sign in to example.com", body: "The dashboard is behind a login." },
      { kind: "sign-in", title: "Postie needs you to connect Gmail", body: "Read mail." },
    ]);
  });

  it("asks once for a proposal left open, and not for one applied at once", async () => {
    const { store, sent, thread } = fixture();
    const applied = store.appendMessage(thread, { role: "bot", kind: "options", card: { title: "New routine", options: ["Allow"], requestId: "a", mcpRequest: {} } as never });
    store.patchMessage(thread, applied.id, { card: { ...applied.card!, autoApplied: true } });
    store.appendMessage(thread, { role: "bot", kind: "options", card: { title: "New skill", options: ["Allow"], requestId: "b", mcpRequest: {} } as never });
    await flush();
    expect(sent).toEqual([expect.objectContaining({ kind: "approval", title: "Postie needs approval", body: "New skill" })]);
  });

  it("leaves a provider's question and approval to the path that already announces them", async () => {
    const { store, sent, thread } = fixture();
    store.appendMessage(thread, { role: "bot", kind: "options", card: { title: "Which?", options: ["A"], requestId: "q", requestType: "question" } as never });
    store.appendMessage(thread, { role: "bot", kind: "options", card: { title: "Allow", options: ["Allow"], requestId: "p", tool: "Bash" } as never });
    await flush();
    expect(sent).toEqual([]);
  });

  it("does not ask for a card settled before anyone could hear of it", async () => {
    const { store, sent, thread, card } = fixture();
    const asked = card();
    store.patchMessage(thread, asked.id, { secret: { ...SECRET, superseded: true } });
    await flush();
    expect(sent).toEqual([]);
  });

  it("stays quiet for the first hour's offer to connect an app", async () => {
    const { store, sent, thread, task } = fixture();
    store.appendMessage(thread, { role: "bot", kind: "connector", text: "connect", connector: { slug: "gmail", label: "Gmail", description: "", status: "required", resumeKey: "first-hour-1" } });
    await flush();
    expect(sent).toEqual([]);
    expect(task().activity).toBe("idle");
  });

  it("does not call a turn finished when it rests on the person, and reminds them when they spoke since the card", async () => {
    const { store, waits, sent, thread, card } = fixture();
    expect(waits.atTurnEnd(thread, "Hello")).toBe(false);
    card();
    await flush();
    sent.length = 0;
    expect(waits.atTurnEnd(thread, "I asked for the password.")).toBe(true);
    expect(sent).toEqual([]);
    store.appendMessage(thread, { role: "user", kind: "text", text: "where is the card?" });
    expect(waits.atTurnEnd(thread, "It is in this conversation.")).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ kind: "secret", title: "Postie needs your Mailbox password", body: "It is in this conversation." })]);
  });

  it("calls a turn finished once the card has settled", () => {
    const { store, waits, thread, card } = fixture();
    const asked = card();
    store.patchMessage(thread, asked.id, { secret: { ...SECRET, provided: true } });
    expect(waits.atTurnEnd(thread, "Read the mail.")).toBe(false);
  });

  it("honours a bot whose notifications are off", async () => {
    const { store, sent, bot, card } = fixture();
    store.patchBot(bot.id, { notifications: false } as never);
    card();
    await flush();
    expect(sent).toEqual([]);
  });
});
