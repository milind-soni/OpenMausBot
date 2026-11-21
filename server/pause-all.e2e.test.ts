// Pausing every bot on a real server whose AI is the scripted Claude engine: FAKE_CLAUDE_PROMPTS gets one line per
// model turn, so the test counts what the pause saved.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let fixture: VerificationServer;
const logDir = mkdtempSync(join(tmpdir(), "omb-pause-all-"));
const promptLog = join(logDir, "prompts.jsonl");
const modelRequests = () => {
  try { return readFileSync(promptLog, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
};
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
};
const ok = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
type FixtureBot = { id: string; activeTaskId: string };
const newBot = async (name: string) => (await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]) as { bot: FixtureBot }).bot;
const send = (bot: FixtureBot, text: string) => call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.activeTaskId, sendId: randomUUID() });
const dueSoon = async (bot: FixtureBot, name: string, inMs: number) =>
  (await ok("POST", "/api/routines", { name, prompt: `Do ${name}.`, botId: bot.id, schedule: { type: "once", at: Date.now() + inMs } })).routine as { id: string };
const runsOf = async (routineIds: string[]) => ((await ok("GET", "/api/routines")).runs as Array<{ routineId: string; status: string; error?: string }>)
  .filter((run) => routineIds.includes(run.routineId));

beforeAll(async () => { fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_PROMPTS: promptLog }); }, 120_000);
afterAll(async () => { await fixture?.close(); await removeTempDir(logDir); });

it("pausing every bot stops what the routines spend, each due run leaving its row, and resuming brings them back", async () => {
  const chief = ((await ok("GET", "/api/bots")).bots as Array<{ id: string; chiefOfStaff?: boolean }>).find((bot) => bot.chiefOfStaff);
  if (chief) await ok("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
  const bots = [await newBot("Ada"), await newBot("Bo"), await newBot("Cy")];
  const everyBot = ((await ok("GET", "/api/bots")).bots as Array<{ id: string }>).map((bot) => bot.id).sort();

  const before = await Promise.all(bots.map((bot, index) => dueSoon(bot, `Morning ${index}`, 1_500)));
  await expect.poll(async () => (await runsOf(before.map((routine) => routine.id))).map((run) => run.status), { timeout: 60_000 }).toEqual(["completed", "completed", "completed"]);
  const spentUnpaused = modelRequests();
  expect(spentUnpaused).toBe(3);

  await ok("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: true });
  const during = await Promise.all(bots.map((bot, index) => dueSoon(bot, `Noon ${index}`, 4_000)));
  const paused = await ok("POST", "/api/paused", { kind: "all", paused: true });
  expect(paused).toMatchObject({ all: true, bots: [bots[0]!.id], departments: [] });
  expect([...paused.heldBots as string[]].sort()).toEqual(everyBot);
  expect((await ok("GET", "/api/config")).pausedByPerson).toMatchObject({ all: true });

  await expect.poll(async () => (await runsOf(during.map((routine) => routine.id))).map((run) => run.status), { timeout: 60_000 }).toEqual(["cancelled", "cancelled", "cancelled"]);
  const rows = await runsOf(during.map((routine) => routine.id));
  expect(rows.map((run) => run.error).sort()).toEqual(["Ada", "Bo", "Cy"].map((name) =>
    `Every bot is paused, so ${name} takes no new work. Resume every bot from any bot’s menu in the sidebar.`));
  const refused = await send(bots[1]!, "Hello.");
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: "bot_held" });
  expect(modelRequests() - spentUnpaused).toBe(0);

  const resumed = await ok("POST", "/api/paused", { kind: "all", paused: false });
  expect(resumed).toMatchObject({ bots: [bots[0]!.id], heldBots: [bots[0]!.id], stopped: 0 });
  expect(resumed.all).toBeUndefined();
  const after = [await dueSoon(bots[1]!, "Evening", 1_000)];
  await expect.poll(async () => (await runsOf(after.map((routine) => routine.id))).map((run) => run.status), { timeout: 60_000 }).toEqual(["completed"]);
  expect(modelRequests() - spentUnpaused).toBe(1);
  expect((await send(bots[0]!, "Still paused?")).status).toBe(409);
  expect((await call("POST", "/api/paused", { kind: "all", id: "x", paused: true })).status).toBe(400);
  const fromTerminal = await fetch(`${fixture.info.url}/api/paused`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "all", paused: true }) });
  expect(fromTerminal.status).toBe(200);
  expect(await fromTerminal.json()).toMatchObject({ all: true });
}, 240_000);
