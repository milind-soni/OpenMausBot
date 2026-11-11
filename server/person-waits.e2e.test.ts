// A bot asks for a password and ends its turn. Real server and agents tools on the fake engine: the person hears about
// it, every surface says the conversation waits on them, and only settling the card ends that. Nothing here reaches the
// user's data or port 8799.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hostTimeout } from "./testing/host-timeout.ts";
import { launchRestartableServer, type RestartableServer } from "./testing/restartable-server.ts";

const ASK = { tool: "request_credential", arguments: { label: "Mailbox password", reason: "To read the mail.", delivery: "ref" } };

async function scenario(test: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const server = await launchRestartableServer({ scripted: true });
  try {
    await test(await fixture(server));
  } finally {
    await server.close();
  }
}

async function fixture(server: RestartableServer) {
  const { url, planPath } = server;
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBeLessThan(300);
    return parsed;
  };
  const bot = (await api("/api/bots", { name: "Postie" })).bot;
  const chief = (await api("/api/bots", { name: "Clive" })).bot;
  const task = async (threadId: string, botId = bot.id) => (await api("/api/bots?messages=0")).bots.find((one: any) => one.id === botId).tasks.find((row: any) => row.threadId === threadId);
  const owner = async (botId = bot.id) => (await api("/api/bots?messages=0")).bots.find((one: any) => one.id === botId);
  const notes = async () => (await api("/api/notifications")).notifications as any[];
  const notesOf = async (kind: string, botId = bot.id) => (await notes()).filter((note) => note.kind === kind && note.botId === botId);
  const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
  const card = async (threadId: string, label = "Mailbox password") => (await messages(threadId)).findLast((message) => message.secret?.label === label);
  const say = (threadId: string, text: string, botId = bot.id) => api(`/api/bots/${botId}/messages`, { text, threadId, sendId: crypto.randomUUID() });
  const turns = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const said = async (threadId: string, text: string) => expect.poll(async () => (await messages(threadId)).some((message) => message.text === text && message.turnTerminal), { timeout: 20_000 }).toBe(true);
  const settled = (threadId: string) => expect.poll(async () => (await task(threadId))?.busy, { timeout: 20_000 }).toBe(false);
  return { server, api, bot, chief, task, owner, notes, notesOf, messages, card, say, turns, said, settled, plan: (plan: unknown) => writeFileSync(planPath, JSON.stringify(plan)) };
}

it("a card in the person's own conversation: they are told, it waits on them, and no \"finished\" says otherwise", () => scenario(async (f) => {
  f.plan({ [f.bot.id]: { script: [
    { key: "ask", match: ["READ-MAIL"], steps: [ASK], reply: "ASKED: waiting for the password." },
    { key: "where", match: ["WHERE"], reply: "STILL: the card is in this conversation." },
    { key: "resume", match: ["secret update"], reply: "RESUMED: no password, so no mail." },
  ] } });
  const thread = f.bot.threadId;
  await f.say(thread, "READ-MAIL please");
  await f.said(thread, "ASKED: waiting for the password.");
  await f.settled(thread);

  await expect.poll(() => f.task(thread), { timeout: 10_000 }).toMatchObject({ activity: "waiting-on-you", busy: false });
  expect(await f.owner()).toMatchObject({ activity: "waiting-on-you", busy: false });
  await expect.poll(() => f.notesOf("secret"), { timeout: 10_000 }).toHaveLength(1);
  expect((await f.notesOf("secret"))[0]).toMatchObject({ threadId: thread, title: "Postie needs your Mailbox password", body: "To read the mail." });
  expect(await f.notesOf("done")).toEqual([]);
  expect((await f.api("/api/needs-you")).items).toEqual([expect.objectContaining({ kind: "question", threadId: thread, botId: f.bot.id, text: expect.stringContaining("Mailbox password") })]);

  // Their next line still runs a turn, and the reply reaches them as the card it waits on, never as "finished".
  await f.say(thread, "WHERE is the card?");
  await f.said(thread, "STILL: the card is in this conversation.");
  await f.settled(thread);
  await expect.poll(() => f.task(thread), { timeout: 10_000 }).toMatchObject({ activity: "waiting-on-you", busy: false });
  await expect.poll(() => f.notesOf("secret"), { timeout: 10_000 }).toHaveLength(2);
  expect((await f.notesOf("secret"))[0]).toMatchObject({ title: "Postie needs your Mailbox password", body: "STILL: the card is in this conversation." });
  expect(await f.notesOf("done")).toEqual([]);
  expect((await f.api("/api/needs-you")).items).toEqual([expect.objectContaining({ threadId: thread, text: expect.stringContaining("Mailbox password") })]);

  // Declining settles it: nothing waits on them, and the bot's next word is ordinary news again.
  const asked = await f.card(thread);
  await f.api(`/api/bots/${f.bot.id}/secret-cards/${asked.id}/dismiss`, { threadId: thread });
  await f.said(thread, "RESUMED: no password, so no mail.");
  await f.settled(thread);
  await expect.poll(() => f.task(thread), { timeout: 10_000 }).toMatchObject({ activity: "idle", busy: false });
  expect((await f.owner()).busy).toBe(false);
  expect((await f.api("/api/needs-you")).items).toEqual([]);
  await expect.poll(() => f.notesOf("done"), { timeout: 10_000 }).toHaveLength(1);
}), hostTimeout(90_000));

it("a card in work a bot handed on reaches the person, and saving it carries the work on", () => scenario(async (f) => {
  f.plan({
    [f.chief.id]: { script: [
      { key: "hand", match: ["GET-MAIL"], steps: [{ arguments: { bot_ids: [f.bot.id], message: "WORK: read the mail", thread: "new" } }], reply: "HANDED: Postie is on it." },
      { key: "any", match: [], repeat: true, reply: "BACK: noted." },
    ] },
    [f.bot.id]: { script: [
      { key: "ask", match: ["WORK"], steps: [ASK], reply: "ASKED: waiting for the password." },
      { key: "resume", match: ["secret update"], reply: "DONE: the mail is read." },
      { key: "any", match: [], repeat: true, reply: "OK" },
    ] },
  });
  await f.say(f.chief.threadId, "GET-MAIL please", f.chief.id);
  let work: any;
  await expect.poll(async () => {
    work = (await f.owner()).tasks.find((row: any) => row.openedBy?.botId === f.chief.id);
    return work?.threadId && (await f.card(work.threadId)) !== undefined;
  }, { timeout: 20_000 }).toBe(true);
  await f.said(work.threadId, "ASKED: waiting for the password.");
  await f.settled(work.threadId);

  await expect.poll(() => f.task(work.threadId), { timeout: 10_000 }).toMatchObject({ activity: "waiting-on-you", busy: false });
  await expect.poll(() => f.notesOf("secret"), { timeout: 10_000 }).toHaveLength(1);
  expect((await f.notesOf("secret"))[0]).toMatchObject({ threadId: work.threadId, title: "Postie needs your Mailbox password" });
  expect(await f.notesOf("done")).toEqual([]);
  expect(await f.notesOf("delegation-settled"), "work resting on a person has no results to announce").toEqual([]);

  const asked = await f.card(work.threadId);
  await f.api(`/api/bots/${f.bot.id}/secret-cards/${asked.id}/save`, { threadId: work.threadId, value: "not-a-real-password" });
  await f.said(work.threadId, "DONE: the mail is read.");
  await f.settled(work.threadId);
  await expect.poll(() => f.task(work.threadId), { timeout: 10_000 }).toMatchObject({ activity: "idle", busy: false });
}), hostTimeout(90_000));

it("what rested on the person still does after a restart, with no second notification", () => scenario(async (f) => {
  f.plan({ [f.bot.id]: { script: [
    { key: "ask", match: ["READ-MAIL"], steps: [ASK], reply: "ASKED: waiting for the password." },
    { key: "any", match: [], repeat: true, reply: "OK" },
  ] } });
  const thread = f.bot.threadId;
  await f.say(thread, "READ-MAIL please");
  await f.said(thread, "ASKED: waiting for the password.");
  await f.settled(thread);
  await expect.poll(() => f.notesOf("secret"), { timeout: 10_000 }).toHaveLength(1);

  await f.server.stop();
  await f.server.start();
  await expect.poll(() => f.task(thread), { timeout: 20_000 }).toMatchObject({ activity: "waiting-on-you", busy: false });
  expect(await f.notesOf("secret")).toHaveLength(1);
  const asked = await f.card(thread);
  await f.api(`/api/bots/${f.bot.id}/secret-cards/${asked.id}/dismiss`, { threadId: thread });
  await expect.poll(async () => (await f.task(thread)).activity, { timeout: 20_000 }).not.toBe("waiting-on-you");
}), hostTimeout(90_000));

it("a card a webhook's run asks for reaches the person, and its report is not called finished", () => scenario(async (f) => {
  f.plan({ [f.bot.id]: { script: [
    { key: "hook", match: ["new-mail-signal"], repeat: true, steps: [ASK], reply: "ASKED: waiting for the password." },
    { key: "any", match: [], repeat: true, reply: "OK" },
  ] } });
  const hook = await f.api("/api/webhooks", { name: "New mail", prompt: "new-mail-signal: check the mailbox", botId: f.bot.id });
  const fired = await fetch(hook.credential.url, { method: "POST", headers: { authorization: `Bearer ${hook.credential.secret}`, "content-type": "application/json" }, body: "{}" });
  expect(fired.status).toBe(202);
  await expect.poll(() => f.notesOf("secret"), { timeout: 20_000 }).toHaveLength(1);
  const thread = (await f.notesOf("secret"))[0].threadId;
  expect((await f.card(thread))).toBeDefined();
  await f.settled(thread);
  await expect.poll(() => f.task(thread), { timeout: 10_000 }).toMatchObject({ activity: "waiting-on-you", busy: false });
  expect(await f.notesOf("done")).toEqual([]);
}), hostTimeout(90_000));

it("work queued for a bot busy elsewhere does not blame a card that holds no slot", () => scenario(async (f) => {
  const gate = join(f.server.dataDir, "free-the-slot");
  f.plan({
    [f.chief.id]: { script: [
      { key: "hand", match: ["GET-MAIL"], steps: [{ arguments: { bot_ids: [f.bot.id], message: "WORK: read the mail", thread: "new" } }], reply: "HANDED: Postie is on it." },
      { key: "any", match: [], repeat: true, reply: "BACK: noted." },
    ] },
    [f.bot.id]: { script: [
      { key: "ask", match: ["READ-MAIL"], steps: [ASK], reply: "ASKED: waiting for the password." },
      { key: "busy", match: ["BUSY"], gateFile: gate, timeoutMs: 60_000, reply: "FREE: the other job is done." },
      { key: "any", match: [], repeat: true, reply: "OK" },
    ] },
  });
  const thread = f.bot.threadId;
  await f.say(thread, "READ-MAIL please");
  await f.said(thread, "ASKED: waiting for the password.");
  await expect.poll(() => f.task(thread), { timeout: 10_000 }).toMatchObject({ activity: "waiting-on-you", busy: false });
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PATCH");
  const { task } = await f.api(`/api/bots/${f.bot.id}/tasks`, { title: "Other job", select: false });
  await f.say(task.threadId, "BUSY for a while");
  await expect.poll(async () => (await f.task(task.threadId))?.busy, { timeout: 15_000 }).toBe(true);

  await f.say(f.chief.threadId, "GET-MAIL please", f.chief.id);
  await f.said(f.chief.threadId, "HANDED: Postie is on it.");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect((await f.messages(f.chief.threadId)).filter((message) => String(message.tool?.name ?? "").includes("behind your"))).toEqual([]);
  writeFileSync(gate, "go");
  await f.said(task.threadId, "FREE: the other job is done.");
}), hostTimeout(90_000));
