// A computer that keeps its bots on itself after it moved, end to end: two computers moved to one My Cloud, then the first
// turns on "Keep this computer's bots on this computer". Its bots come home with what they did on My Cloud, their
// automations run there again and stop on My Cloud, the other computer and its bots on My Cloud don't change, and turning
// it off again moves it again. Each computer's server and app (main's own wiring), one Cloud home; disposable homes; no
// network.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendDesk, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { webhookHomeLine } from "./cloud-send-arrived.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-keep-${randomBytes(8).toString("hex")}`;
let fx: CloudSendFixture, studio: CloudSendDesk;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, env: { OMB_ENVIRONMENT_LABEL: "MacBook Air" } });
  studio = await fx.addDesk({ label: "Studio iMac" });
}, hostTimeout(120_000));
afterAll(async () => { await fx?.close(); });

type Side = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Row = { id: string; role: string; text?: string };
type Run = { id: string; routineId: string; createdAt: number; status: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { phase: string; kept?: true } | null : null);
async function rows(side: Side, threadId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let before: string | null = null, more = true; more;) {
    const page: { messages: Row[]; hasMore?: boolean } = (await side("GET", `/api/threads/${threadId}/messages?limit=500${before ? `&before=${before}` : ""}`)).body;
    out.unshift(...page.messages);
    more = page.hasMore === true;
    before = page.messages[0]?.id ?? null;
  }
  return out;
}
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function turn(side: Side, bot: { id: string; threadId: string }, text: string) {
  const before = (await rows(side, bot.threadId)).length;
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => await idle(side) && (await rows(side, bot.threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const routines = async (side: Side) => (await side("GET", "/api/routines")).body as { routines: Array<{ id: string; name: string; enabled: boolean }>; runs: Run[] };
const switches = async (side: Side) => (await routines(side)).routines.map((routine) => [routine.name, routine.enabled]).sort();
const hooks = async (side: Side) => ((await side("GET", "/api/webhooks")).body.webhooks as Array<{ name: string; enabled: boolean }>).map((hook) => [hook.name, hook.enabled]).sort();
async function ranSince(side: Side, since: number): Promise<string[]> {
  const { routines: list, runs } = await routines(side);
  return runs.filter((run) => run.createdAt >= since).map((run) => list.find((routine) => routine.id === run.routineId)?.name ?? run.routineId).sort();
}
const said = (journalFile: string) => `${JSON.stringify(read(journalFile))}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main")).join("\n")}`;
async function until(oneHome: { kick(): Promise<void> }, journalFile: string, phase: string) {
  for (let round = 0; round < 240 && read(journalFile)?.phase !== phase; round++) { await oneHome.kick(); if (read(journalFile)?.phase !== phase) await sleep(500); }
  expect(read(journalFile)?.phase, said(journalFile)).toBe(phase);
}

it("turned on after the move, this computer's bots come home with what they did on My Cloud, run here and stop there, and the other computer doesn't change; turned off, it moves again", async () => {
  const air = fx.local, imac = studio.local;
  const add = async (side: Side, body: Record<string, unknown>) => { const made = (await side("POST", "/api/routines", body)).body; return (made.routine ?? made).id as string; };
  const later = { type: "interval", everyMinutes: 1_440, anchorAt: Date.now() + 2 * 86_400_000 };
  const scout = (await air("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await turn(air, scout, "Plan the week.");
  await add(air, { name: "Air at every start", prompt: "Say hello from the Air.", botId: scout.id, runOnStartup: true, schedule: later, durationMinutes: 15 });
  expect((await air("POST", "/api/webhooks", { name: "Air orders", prompt: "File the order.", botId: scout.id })).status).toBeLessThan(300);
  const pip = (await imac("POST", "/api/bots", { name: "Pip", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await turn(imac, pip, "Hello Pip.");
  await add(imac, { name: "iMac at every start", prompt: "Say hello from the iMac.", botId: pip.id, runOnStartup: true, schedule: later, durationMinutes: 15 });
  expect((await imac("POST", "/api/webhooks", { name: "iMac orders", prompt: "File the order.", botId: pip.id })).status).toBeLessThan(300);
  await expect.poll(() => idle(air), { timeout: 60_000, interval: 200 }).toBe(true);
  await expect.poll(() => idle(imac), { timeout: 60_000, interval: 200 }).toBe(true);

  const kept: string[] = [], moved: string[] = [];
  fx.account.reportMove = async ({ installation }) => { moved.push(installation); return true; };
  fx.account.reportKept = async ({ installation }) => { kept.push(installation); return true; };
  studio.account.reportKept = async () => { throw new Error("the other computer says nothing"); };
  const movable = { status: "ready", origin: fx.cloudBase, moves: true };
  fx.account.state = { ...fx.account.state, deviceId: "device-air", machine: movable };
  await until(fx.oneHome, fx.journalFile, "done");
  studio.account.state = { ...studio.account.state, deviceId: "device-imac", machine: movable };
  await until(studio.oneHome, studio.journalFile, "done");
  expect(await switches(fx.onCloud)).toEqual([["Air at every start", true], ["iMac at every start", true]]);
  expect(await hooks(fx.onCloud)).toEqual([["Air orders", true], ["iMac orders", true]]);
  // On My Cloud since: a turn with each computer's bot.
  await turn(fx.onCloud, scout, "From My Cloud: book the venue.");
  await turn(fx.onCloud, pip, "From My Cloud: order more paper.");
  const cloudScout = (await rows(fx.onCloud, scout.threadId)).map((row) => row.id);
  const imacBefore = { journal: read(studio.journalFile), frozen: (await imac("GET", "/api/move/freeze")).body.frozen, routines: await switches(imac) };

  // Settings → MausBot Cloud, Advanced, on My Cloud's page: the switch, and the person confirming it.
  expect(await fx.call("one-home:keep", "cloud")).toEqual({ shown: true, on: false, moved: true, coming: false });
  expect(await fx.call("one-home:keep-set", "cloud", true)).toMatchObject({ shown: true, on: true });
  await until(fx.oneHome, fx.journalFile, "back");
  expect(read(fx.journalFile)?.kept).toBe(true);
  expect(fx.spies.relaunches, "the app opens again to finish the restore").toBe(1);
  expect(await switches(fx.onCloud), "this computer's automations stop on My Cloud; the other computer's go on").toEqual([["Air at every start", false], ["iMac at every start", true]]);
  expect(await hooks(fx.onCloud)).toEqual([["Air orders", false], ["iMac orders", true]]);

  const back = Date.now();
  await fx.relaunch({ kill: false });
  await fx.oneHome.kick();
  expect((await air("GET", "/api/move/freeze")).body.frozen).toBe(false);
  expect(fx.oneHome.away(), "the window goes back to this computer, with the switcher").toBe(false);
  expect(fx.oneHome.view()).toEqual({ phase: "back", kept: true });
  expect(await switches(air), "this computer's automations run here; the other computer's came too, off").toEqual([["Air at every start", true], ["iMac at every start", false]]);
  expect(await hooks(air)).toEqual([["Air orders", true], ["iMac orders", false]]);
  expect((await rows(air, scout.threadId)).map((row) => row.id), "what Scout did on My Cloud came home").toEqual(expect.arrayContaining(cloudScout));
  const homeLines = async (bot: { threadId: string }, name: string) => (await rows(air, bot.threadId)).filter((row) => row.text === webhookHomeLine(name)).length;
  expect([await homeLines(scout, "Air orders"), await homeLines(pip, "iMac orders")], "only this computer's webhook says it has an address here again").toEqual([1, 0]);
  expect(kept, "the Admin is told once that this computer no longer counts as moved").toEqual([moved[0]]);

  // Opened again, its own routine runs here and nowhere else.
  await fx.relaunch({ kill: false });
  await fx.oneHome.kick();
  await expect.poll(() => ranSince(air, back), { timeout: 30_000, interval: 250 }).toEqual(["Air at every start"]);
  expect(await ranSince(fx.onCloud, back)).toEqual([]);
  expect(kept).toHaveLength(1);

  // The other computer: nothing changed, and nothing of it runs anywhere but My Cloud.
  expect({ journal: read(studio.journalFile), frozen: (await imac("GET", "/api/move/freeze")).body.frozen, routines: await switches(imac) }).toEqual(imacBefore);
  await studio.relaunch({ kill: false });
  await studio.oneHome.kick();
  expect(read(studio.journalFile)?.phase).toBe("done");
  expect(await ranSince(imac, back)).toEqual([]);

  // Turned off again: this computer moves again, as anyone's first move, and My Cloud runs its automations.
  expect(await fx.call("one-home:keep-set", "local", false)).toMatchObject({ on: false });
  await until(fx.oneHome, fx.journalFile, "done");
  expect(read(fx.journalFile)?.kept).toBeUndefined();
  expect((await air("GET", "/api/move/freeze")).body.frozen).toBe(true);
  expect(await switches(fx.onCloud)).toEqual([["Air at every start", true], ["iMac at every start", true]]);
  expect(await hooks(fx.onCloud)).toEqual([["Air orders", true], ["iMac orders", true]]);
  expect(moved, "told again that it moved").toEqual([moved[0], moved[0]]);
}, hostTimeout(900_000));
