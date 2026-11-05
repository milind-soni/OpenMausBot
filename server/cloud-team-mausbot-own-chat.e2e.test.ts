// A Team Cloud member's own MausBot: its main chat is theirs alone, on a Team Cloud with the synthetic Claude CLI. No
// admin or other member reads it through any route, and its notes go to the person's own layer. A MausBot made before
// this gets the same at the next start, its earlier notes moved out of the bot's own folder.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/plan.json";`;
const SAID = "MAIN-CHAT-LINE Kestrel19";
const NOTE = "Mira prefers the Kestrel19 supplier";
const OLD_NOTE = "Ben's old note Heron77";

type Task = { threadId: string; private?: true };
type Bot = { id: string; threadId: string; defaultBot?: { person?: string }; tasks?: Task[] };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", mira = "", ben = "";

const planPath = () => join(team.home, "plan.json");
const dataDir = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
const turns = (): Array<{ planKey?: string }> => existsSync(`${planPath()}.evidence.jsonl`)
  ? readFileSync(`${planPath()}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const botsOf = async (token: string, messages = "") => (await team.as(token, "GET", `/api/bots${messages}`)).body.bots as Bot[];
const ownMausBot = async (token: string) => (await botsOf(token)).find((bot) => bot.defaultBot?.person)!;
const layer = (bot: Bot, email: string) => dataDir("workspaces", `${bot.id}--member-${personKey({ id: "", email })}`, "MEMORY.md");
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
/** Everything a person can fetch about a bot and its main chat, in one string. */
async function everything(token: string, bot: Bot): Promise<string> {
  const paths = ["/api/bots", "/api/bots?messages=1", `/api/bots/${bot.id}`, `/api/threads/${bot.threadId}/messages?limit=200`,
    `/api/bots/${bot.id}/memory`, `/api/bots/${bot.id}/memory/file`, `/api/bots/${bot.id}/memory/journal`, `/api/bots/${bot.id}/memory/mine`,
    "/api/search?q=Kestrel19", "/api/search?q=Heron77", `/api/bots/${bot.id}/tasks`, "/api/notifications", "/api/inbox"];
  const answers = await Promise.all(paths.map(async (path) => JSON.stringify((await team.as(token, "GET", path)).body)));
  return answers.join("\n");
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-6", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  mira = (await team.pair(MIRA)).token!;
  ben = (await team.pair(BEN)).token!;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
});

it("is the person's own: private on the wire, its notes in their layer, and nobody else reads it through any route", async () => {
  const maus = await ownMausBot(mira);
  expect(maus.tasks!.find((task) => task.threadId === maus.threadId)?.private, "her main chat is marked hers").toBe(true);
  expect((maus as Bot & { mainThreadId?: string }).mainThreadId, "and it is still her MausBot's main chat").toBe(maus.threadId);
  const other = await team.as(mira, "POST", `/api/bots/${maus.id}/tasks`, { title: "Another chat" });
  expect(other.status).toBe(201);
  expect(((await botsOf(mira)).find((bot) => bot.id === maus.id) as Bot & { mainThreadId?: string }).mainThreadId, "a newer chat of hers doesn't become it").toBe(maus.threadId);
  writeFileSync(planPath(), JSON.stringify({ [maus.id]: { script: [
    { key: "M-NOTE", repeat: true, match: ["MAIN-CHAT-LINE"], reply: "Noted Kestrel19.", steps: [{ tool: "memory_update", arguments: { action: "append", text: NOTE } }] },
  ] } }));
  expect((await team.as(mira, "POST", `/api/bots/${maus.id}/messages`, { text: SAID, threadId: maus.threadId })).status).toBe(202);
  await expect.poll(() => turns().some((one) => one.planKey === "M-NOTE"), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => read(layer(maus, MIRA.email)), { timeout: 30_000 }).toContain(NOTE);
  expect(read(dataDir("workspaces", maus.id, "MEMORY.md"))).not.toContain(NOTE);

  expect(await everything(mira, maus)).toContain("Kestrel19");
  expect((await team.as(olive, "GET", `/api/threads/${maus.threadId}/messages?limit=1`)).status, "the Owner").toBe(404);
  expect((await team.as(ben, "GET", `/api/threads/${maus.threadId}/messages?limit=1`)).status, "another member").toBe(404);
  for (const token of [olive, ben]) expect(await everything(token, maus)).not.toContain("Kestrel19");
}, hostTimeout(120_000));

it.each([
  ["en", "This note moved here from where the bot kept it before, so it can't be reverted here."],
  ["pt-br", "Esta nota veio de onde o bot a guardava antes, então não é possível reverter a alteração aqui."],
])("moves earlier notes to their person's layer in %s when the server is English", async (language, reason) => {
  expect((await team.as(olive, "PUT", "/api/config", { language: "en" })).status).toBe(200);
  expect((await team.as(ben, "POST", "/api/presence/active", { source: "desktop", language })).status).toBe(200);
  const maus = await ownMausBot(ben);
  expect((await team.as(ben, "POST", `/api/bots/${maus.id}/messages`, { text: "NO-SCRIPT Heron77 hello", threadId: maus.threadId })).status).toBe(202);
  await expect.poll(async () => JSON.stringify((await team.as(ben, "GET", `/api/threads/${maus.threadId}/messages?limit=50`)).body), { timeout: 60_000 }).toContain("Heron77");
  // As an earlier version left it: no person for the main chat, and a note in the bot's own folder.
  const starters = JSON.parse(readFileSync(dataDir("thread-starters.json"), "utf8")) as Record<string, string>;
  delete starters[maus.threadId];
  writeFileSync(dataDir("thread-starters.json"), JSON.stringify(starters));
  mkdirSync(dataDir("workspaces", maus.id), { recursive: true });
  writeFileSync(dataDir("workspaces", maus.id, "MEMORY.md"), `# Memory\n\n- ${OLD_NOTE}\n`);
  mkdirSync(dataDir("memory-journal"), { recursive: true });
  writeFileSync(dataDir("memory-journal", `${maus.id}.ndjson`), `${JSON.stringify({ id: `old-${language}`, botId: maus.id, at: Date.now(), path: "MEMORY.md", actor: "bot", after: OLD_NOTE })}\n`);

  await team.relaunch();
  olive = (await team.pair(OLIVE)).token!;
  ben = (await team.pair(BEN)).token!;
  expect((await team.as(olive, "GET", "/api/config")).body.language).toBe("en");
  await expect.poll(() => read(layer(maus, BEN.email)), { timeout: 30_000 }).toContain(OLD_NOTE);
  const journal = read(dataDir("memory-journal", `${maus.id}--member-${personKey({ id: "", email: BEN.email })}.ndjson`))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  expect(journal.find((row) => row.id === `old-${language}`)).toMatchObject({ before: null, canRevert: false, revertUnavailableReason: reason });
  expect(read(dataDir("workspaces", maus.id, "MEMORY.md"))).not.toContain(OLD_NOTE);
  expect(read(dataDir("memory-journal", `${maus.id}.ndjson`))).not.toContain(OLD_NOTE);
  expect((await ownMausBot(ben)).tasks!.find((task) => task.threadId === maus.threadId)?.private).toBe(true);
  expect(await everything(ben, maus)).toContain("Heron77");
  expect((await team.as(olive, "GET", `/api/threads/${maus.threadId}/messages?limit=1`)).status).toBe(404);
  expect(await everything(olive, maus)).not.toContain("Heron77");
}, hostTimeout(180_000));
