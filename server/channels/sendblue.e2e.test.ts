// Against the real server with the scripted engine and a loopback stand-in for Sendblue: a key and number are connected
// for one bot, the person's phone links by texting "link <code>", a text from it reaches the bot, and the bot's reply
// is sent from the bot's number to the phone; a second bot's key stays its own, and an unlinked number and a group
// message are never heard.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { startFakeSendblue, type FakeSendblue } from "../testing/fake-sendblue.ts";

const SCOUT = { keyId: "key-scout-0001", secret: "secret-scout-aaaa-bbbb", number: "+14155550100" };
const MIRA = { keyId: "key-mira-0002", secret: "secret-mira-cccc-dddd", number: "+14155550200" };
const ADA = "+14155550123";
const BEN = "+14155550124";

let fixture: VerificationServer | undefined;
let fake: FakeSendblue | undefined;
afterEach(async () => {
  await fixture?.close();
  await fake?.close();
  fixture = fake = undefined;
});

it("connects a key per bot, links the person's phone by text, and answers it over iMessage", async () => {
  fake = await startFakeSendblue({ [SCOUT.keyId]: { secret: SCOUT.secret, number: SCOUT.number }, [MIRA.keyId]: { secret: MIRA.secret, number: MIRA.number } });
  fixture = await launchVerificationServer({ ...process.env, OMB_SENDBLUE_API_BASE: fake.url }, undefined, undefined, undefined, undefined, { scripted: true });
  const url = fixture.info.url;
  const api = (path: string, body?: unknown, method = "POST") => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, url) as Promise<any>;
  const scout = (await runControlOmb(["new-bot", "--name", "Scout", "--url", url]) as any).bot;
  const mira = (await runControlOmb(["new-bot", "--name", "Mira", "--url", url]) as any).bot;
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [scout.id]: { reply: "Three meetings and one deadline." }, [mira.id]: { reply: "Mira here." } }));
  const sentTexts = (to?: string) => fake!.sent.filter((entry) => !to || entry.to === to).map((entry) => entry.content);

  expect(await api(`/api/bots/${scout.id}/imessage`, undefined, "GET")).toEqual({ available: true, connected: false, chats: [] });
  await expect(api(`/api/bots/${scout.id}/imessage`, { ...SCOUT, secret: "wrong-secret-wrong" })).rejects.toThrow(/doesn't know that API key ID and secret/);
  expect(await api(`/api/bots/${scout.id}/imessage`, SCOUT)).toMatchObject({ connected: true, number: SCOUT.number, chats: [] });
  expect(await api(`/api/bots/${mira.id}/imessage`, MIRA)).toMatchObject({ connected: true, number: MIRA.number, chats: [] });
  const saved = readFileSync(join(fixture.info.dataDir, "imessage.json"), "utf8");
  for (const secret of [SCOUT.secret, MIRA.secret, SCOUT.keyId, MIRA.keyId]) expect(saved).not.toContain(secret);

  const link = await api(`/api/bots/${scout.id}/imessage/link`, {});
  expect(link).toMatchObject({ command: `link ${link.code}`, url: `sms:${SCOUT.number}&body=link%20${link.code}` });
  fake.push(SCOUT.keyId, ADA, link.command);
  await expect.poll(() => sentTexts(), { timeout: 20_000, interval: 250 }).toEqual(["You're connected to Scout. Message me here any time."]);
  expect(await api(`/api/bots/${scout.id}/imessage`, undefined, "GET")).toMatchObject({ connected: true, chats: [{ id: ADA }] });

  fake.push(SCOUT.keyId, ADA, "hello");
  await expect.poll(() => sentTexts(ADA), { timeout: 30_000, interval: 250 }).toEqual(["You're connected to Scout. Message me here any time.", "Three meetings and one deadline."]);
  expect(fake.sent.every((entry) => entry.keyId === SCOUT.keyId && entry.from === SCOUT.number && entry.to === ADA)).toBe(true);
  const thread = (await api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === scout.id).tasks.find((task: any) => task.title === "iMessage");
  expect(thread, "Scout has an iMessage thread").toBeTruthy();
  const said = (await api(`/api/threads/${thread.threadId}/messages`, undefined, "GET")).messages;
  expect(said.find((message: any) => message.role === "user")?.text).toBe("hello");

  // An unlinked number, a group, and the linked number texting the other bot's line are heard by nobody and answered by nobody.
  fake.push(SCOUT.keyId, BEN, "Scout, are you there?");
  fake.push(SCOUT.keyId, ADA, "a group message", { group: "g1" });
  fake.push(MIRA.keyId, ADA, "Mira, are you there?");
  const polls = fake.polls.get(MIRA.keyId)!.count;
  await expect.poll(() => fake!.polls.get(MIRA.keyId)!.count, { timeout: 20_000, interval: 250 }).toBeGreaterThan(polls + 2);
  expect(fake.sent).toHaveLength(2);
  expect(await api(`/api/bots/${mira.id}/imessage`, undefined, "GET")).toMatchObject({ connected: true, chats: [] });
  expect((await api("/api/bots", undefined, "GET")).bots.find((bot: any) => bot.id === mira.id).tasks.some((task: any) => task.title === "iMessage")).toBe(false);
  expect((await api(`/api/threads/${thread.threadId}/messages`, undefined, "GET")).messages.filter((message: any) => message.role === "user").map((message: any) => message.text)).toEqual(["hello"]);

  // Disconnect stops the reads and forgets the phone.
  const pollsBefore = fake.polls.get(SCOUT.keyId)!.count;
  expect(await api(`/api/bots/${scout.id}/imessage`, undefined, "DELETE")).toEqual({ available: true, connected: false, chats: [] });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(fake.polls.get(SCOUT.keyId)!.count - pollsBefore).toBeLessThanOrEqual(1);
  expect(readFileSync(join(fixture.info.dataDir, "imessage.json"), "utf8")).not.toContain(scout.id);
}, 180_000);
