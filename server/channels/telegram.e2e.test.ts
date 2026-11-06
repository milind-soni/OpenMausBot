// Against the real server with the scripted engine and a loopback stand-in for Telegram's Bot API: a token is connected
// for one bot, the person's chat links with /start and a code, a message from it reaches the bot, and the bot's reply
// comes back to that chat; a second bot's token stays its own, and an unlinked chat is told once and never heard.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";

const TOKEN_A = "111111111:AAE-scoutscoutscoutscoutscoutscout0001";
const TOKEN_B = "222222222:AAE-miramiramiramiramiramiramira000002";
const ME = 4242;
const STRANGER = 9999;

let fixture: VerificationServer | undefined;
let fake: FakeTelegram | undefined;
afterEach(async () => {
  await fixture?.close();
  await fake?.close();
  fixture = fake = undefined;
});

it("connects a token per bot, links the person's chat, and answers it on Telegram", async () => {
  fake = await startFakeTelegram({ [TOKEN_A]: "scout_bot", [TOKEN_B]: "mira_bot" });
  fixture = await launchVerificationServer({ ...process.env, OMB_TELEGRAM_API_BASE: fake.url }, undefined, undefined, undefined, undefined, { scripted: true });
  const url = fixture.info.url;
  const api = (path: string, body?: unknown, method = "POST") => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, url) as Promise<any>;
  const scout = (await runControlOmb(["new-bot", "--name", "Scout", "--url", url]) as any).bot;
  const mira = (await runControlOmb(["new-bot", "--name", "Mira", "--url", url]) as any).bot;
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [scout.id]: { reply: "Three meetings and one deadline." }, [mira.id]: { reply: "Mira here." } }));

  expect(await api(`/api/bots/${scout.id}/telegram`, undefined, "GET")).toEqual({ available: true, connected: false, chats: [] });
  await expect(api(`/api/bots/${scout.id}/telegram`, { token: "111111111:AAE-wrongwrongwrongwrongwrongwrong0000" })).rejects.toThrow(/doesn't know that token/);
  expect(await api(`/api/bots/${scout.id}/telegram`, { token: TOKEN_A })).toMatchObject({ connected: true, username: "scout_bot", chats: [] });
  expect(await api(`/api/bots/${mira.id}/telegram`, { token: TOKEN_B })).toMatchObject({ connected: true, username: "mira_bot", chats: [] });
  const saved = readFileSync(join(fixture.info.dataDir, "telegram.json"), "utf8");
  expect(saved).not.toContain(TOKEN_A.split(":")[1]);
  expect(saved).not.toContain(TOKEN_B.split(":")[1]);

  const link = await api(`/api/bots/${scout.id}/telegram/link`, {});
  expect(link.url).toBe(`https://t.me/scout_bot?start=${link.code}`);
  expect(link.code).toMatch(/^\d{6}$/);
  fake.push(TOKEN_A, ME, `/start ${link.code}`, { name: "Ada" });
  await expect.poll(() => fake!.sent.map((entry) => entry.text), { timeout: 20_000, interval: 250 }).toEqual(["You're connected to Scout. Message me here any time."]);
  expect(await api(`/api/bots/${scout.id}/telegram`, undefined, "GET")).toMatchObject({ connected: true, chats: [{ id: String(ME), name: "Ada" }] });

  fake.push(TOKEN_A, ME, "What does my week look like?");
  await expect.poll(() => fake!.sent.map((entry) => entry.text), { timeout: 30_000, interval: 250 })
    .toEqual(["You're connected to Scout. Message me here any time.", "Three meetings and one deadline."]);
  expect(fake.sent.every((entry) => entry.token === TOKEN_A && entry.chatId === String(ME))).toBe(true);
  const thread = (await api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === scout.id).tasks.find((task: any) => task.title === "Telegram");
  expect(thread, "Scout has a Telegram thread").toBeTruthy();
  const said = (await api(`/api/threads/${thread.threadId}/messages`, undefined, "GET")).messages;
  expect(said.find((message: any) => message.role === "user")?.text).toBe("What does my week look like?");

  // The same chat is a stranger to Mira: told once, never delivered, and Mira's answer rides her own token.
  fake.push(TOKEN_B, ME, "Mira, are you there?");
  fake.push(TOKEN_B, ME, "Mira?");
  fake.push(TOKEN_A, STRANGER, "Scout, are you there?");
  await expect.poll(() => fake!.sent.filter((entry) => entry.token === TOKEN_B).map((entry) => entry.text), { timeout: 20_000, interval: 250 }).toEqual(["This bot only talks to its owner."]);
  await expect.poll(() => fake!.sent.filter((entry) => entry.chatId === String(STRANGER)).map((entry) => entry.text), { timeout: 20_000, interval: 250 }).toEqual(["This bot only talks to its owner."]);
  expect(await api(`/api/bots/${mira.id}/telegram`, undefined, "GET")).toMatchObject({ connected: true, chats: [] });
  expect((await api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === mira.id).tasks.some((task: any) => task.title === "Telegram")).toBe(false);

  // Disconnect stops the reads and forgets the chat.
  const pollsBefore = fake.polls.get(TOKEN_A)!.count;
  expect(await api(`/api/bots/${scout.id}/telegram`, undefined, "DELETE")).toEqual({ available: true, connected: false, chats: [] });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(fake.polls.get(TOKEN_A)!.count - pollsBefore).toBeLessThanOrEqual(1);
  expect(readFileSync(join(fixture.info.dataDir, "telegram.json"), "utf8")).not.toContain(scout.id);
}, 180_000);
