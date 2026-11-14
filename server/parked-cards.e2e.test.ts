// A turn parked on a card follows the card the bot replaced it with, and a card has one waiting turn. Real server and
// agents tools on the fake engine; nothing here reaches the user's data or port 8799.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  const { url, planPath, dataDir } = server;
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBeLessThan(300);
    return parsed;
  };
  const bot = (await api("/api/bots", { name: "Postie" })).bot;
  const chief = (await api("/api/bots", { name: "Clive" })).bot;
  const owner = async (botId = bot.id) => (await api("/api/bots?messages=0")).bots.find((one: any) => one.id === botId);
  const task = async (threadId: string) => (await owner()).tasks.find((row: any) => row.threadId === threadId);
  const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages as any[];
  const cards = async (threadId: string) => (await messages(threadId)).filter((message) => message.kind === "secret");
  const say = (threadId: string, text: string, botId = bot.id) => api(`/api/bots/${botId}/messages`, { text, threadId, sendId: crypto.randomUUID() });
  const said = (threadId: string, text: string) => expect.poll(async () => (await messages(threadId)).some((message) => message.text === text), { timeout: 20_000 }).toBe(true);
  const nodes = (): any[] => {
    const path = join(dataDir, "runtime.db");
    if (!existsSync(path)) return [];
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all() as Array<{ json: string }>).map((row) => JSON.parse(row.json));
    } finally { db.close(); }
  };
  const turns = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const handOff = async () => {
    await say(chief.threadId, "GET-MAIL please", chief.id);
    let work: any;
    await expect.poll(async () => {
      work = (await owner()).tasks.find((row: any) => row.openedBy?.botId === chief.id);
      return Boolean(work) && (await cards(work.threadId)).length === 1;
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => nodes().find((node) => node.assignee.botId === bot.id)?.status, { timeout: 20_000 }).toBe("needs_input");
    return work.threadId as string;
  };
  return { server, api, bot, chief, owner, task, messages, cards, say, said, nodes, turns, handOff, dataDir, plan: (plan: unknown) => writeFileSync(planPath, JSON.stringify(plan)) };
}

const plans = (f: Awaited<ReturnType<typeof fixture>>) => ({
  [f.chief.id]: { script: [
    { key: "hand", match: ["GET-MAIL"], steps: [{ arguments: { bot_ids: [f.bot.id], message: "WORK: read the mail", thread: "new" } }], reply: "HANDED: Postie is on it." },
    { key: "any", match: [], repeat: true, reply: "BACK: noted." },
  ] },
  [f.bot.id]: { script: [
    { key: "ask", match: ["WORK"], steps: [ASK], reply: "ASKED: waiting for the password." },
    { key: "again", match: ["AGAIN"], steps: [ASK], reply: "ASKED AGAIN: waiting for the password." },
    { key: "resume", match: ["secret update"], reply: "DONE: the mail is read." },
    { key: "any", match: [], repeat: true, reply: "OK" },
  ] },
});

it("work parked on a card follows the newer card that replaced it, and saving that one carries the work on", () => scenario(async (f) => {
  f.plan(plans(f));
  const work = await f.handOff();
  const first = (await f.cards(work))[0];
  const parked = () => f.nodes().find((node) => node.assignee.botId === f.bot.id && node.parentId);
  expect(parked()).toMatchObject({ status: "needs_input", cards: [first.id] });

  // The person writes in the thread and the bot asks again: the first card is replaced while the hand-off stays parked.
  await f.say(work, "AGAIN please");
  await f.said(work, "ASKED AGAIN: waiting for the password.");
  await expect.poll(() => f.cards(work).then((rows) => rows.length), { timeout: 20_000 }).toBe(2);
  const [older, newer] = await f.cards(work);
  expect(older.secret.superseded).toBe(true);
  await expect.poll(() => parked()?.cards, { timeout: 15_000 }).toEqual([newer.id]);
  await expect.poll(async () => (await f.task(work)).busy, { timeout: 15_000 }).toBe(false);

  // A card has one waiting turn: the person's own turn ended when it asked, and doesn't park on the hand-off's card.
  const others = f.nodes().filter((node) => node.status === "needs_input" && node.id !== parked()!.id);
  expect(others).toEqual([]);

  await f.api(`/api/bots/${f.bot.id}/secret-cards/${newer.id}/save`, { threadId: work, value: "not-a-real-password" });
  await f.said(work, "DONE: the mail is read.");
  await expect.poll(() => parked()?.status, { timeout: 20_000 }).toBe("completed");
  expect((await f.messages(work)).filter((message) => message.text === "DONE: the mail is read.")).toHaveLength(1);
  await expect.poll(() => f.nodes().filter((node) => node.status === "needs_input"), { timeout: 15_000 }).toEqual([]);
}), hostTimeout(90_000));

it.each(["en", "pt-br"])("at start, work left parked on a card nothing can answer is let go, and work on an open card stays (%s)", (language) => scenario(async (f) => {
  await f.api("/api/config", { language }, "PATCH");
  f.plan(plans(f));
  const work = await f.handOff();
  const card = (await f.cards(work))[0];
  const parked = () => f.nodes().find((node) => node.assignee.botId === f.bot.id && node.parentId);
  await f.server.stop();
  await f.server.start();
  await expect.poll(() => parked()?.status, { timeout: 20_000 }).toBe("needs_input");
  expect(parked()!.cards).toEqual([card.id]);

  // What an older build left behind: the card was replaced and the parked turn never heard.
  await f.server.stop();
  const db = new DatabaseSync(join(f.dataDir, "messages.db"));
  try {
    const row = db.prepare("SELECT json FROM messages WHERE id = ?").get(card.id) as { json: string };
    const message = JSON.parse(row.json);
    message.secret.superseded = true;
    db.prepare("UPDATE messages SET json = ? WHERE id = ?").run(JSON.stringify(message), card.id);
  } finally { db.close(); }
  await f.server.start();
  await expect.poll(() => parked()?.status, { timeout: 20_000 }).toBe("cancelled");
  expect(parked()).toMatchObject({ result: "The card it waited on was replaced or closed", outcomeDetail: "The card it waited on was replaced or closed" });
  const expected = language === "pt-br"
    ? "Postie — trabalho cancelado: O cartão aguardado foi substituído ou fechado"
    : "Postie — cancelled: The card it waited on was replaced or closed";
  await expect.poll(async () => (await f.messages(f.chief.threadId)).some((message) => message.tool?.name === expected), { timeout: 20_000 }).toBe(true);
  expect(f.nodes().filter((node) => node.status === "needs_input")).toEqual([]);
}), hostTimeout(90_000));
