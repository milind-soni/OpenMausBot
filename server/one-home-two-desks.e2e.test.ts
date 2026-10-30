// Two computers that both moved to one My Cloud, end to end: each computer's server and app (main's own wiring), one
// Cloud home, and the Admin's word in each app's sign-in. When My Cloud ends, everything comes home to the computer the
// Admin names (the one used most recently); the other opens its own copy with every automation off. Both servers' and
// My Cloud's schedules are watched. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendDesk, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-two-desks-${randomBytes(8).toString("hex")}`;
const GATES = mkdtempSync(join(tmpdir(), "omb-two-desks-"));
const HOLD = join(GATES, "hold"), RELEASE = join(GATES, "release");
/** Either computer's turns that start while HOLD exists run until RELEASE does. */
const HOLD_TURNS = `if ((await import("node:fs")).existsSync(${JSON.stringify(HOLD)})) { process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(RELEASE)}; }`;
let fx: CloudSendFixture, studio: CloudSendDesk;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, env: { OMB_ENVIRONMENT_LABEL: "MacBook Air" }, desktopEngine: HOLD_TURNS });
  studio = await fx.addDesk({ label: "Studio iMac" });
}, hostTimeout(120_000));
afterAll(async () => { writeFileSync(RELEASE, ""); await fx?.close(); rmSync(GATES, { recursive: true, force: true }); });

type Side = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Row = { id: string; role: string; text?: string };
type Run = { id: string; routineId: string; createdAt: number; status: string; triggerSource?: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { phase: string; frozenAt?: number; retryAt?: number; elsewhere?: { name: string; since?: number } } | null : null);
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
/** The runs each routine had since `since`, by name. */
async function ranSince(side: Side, since: number): Promise<string[]> {
  const { routines: list, runs } = await routines(side);
  return runs.filter((run) => run.createdAt >= since).map((run) => list.find((routine) => routine.id === run.routineId)?.name ?? run.routineId).sort();
}
/** The journal and what main said, for a failure to show why. */
const said = (journalFile: string) => `${JSON.stringify(read(journalFile))}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main")).join("\n")}`;
async function moveUntilDone(oneHome: { kick(): Promise<void> }, journalFile: string) {
  for (let round = 0; round < 240 && read(journalFile)?.phase !== "done"; round++) { await oneHome.kick(); if (read(journalFile)?.phase !== "done") await sleep(500); }
  expect(read(journalFile)?.phase, said(journalFile)).toBe("done");
}

it("My Cloud ends after two computers moved to it: everything comes home to the one used most recently, and the other runs nothing", async () => {
  const air = fx.local, imac = studio.local;
  // Each computer's own bots and automations, before either moved.
  const scout = (await air("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await turn(air, scout, "Plan the week.");
  const add = async (side: Side, body: Record<string, unknown>) => { const made = (await side("POST", "/api/routines", body)).body; return (made.routine ?? made).id as string; };
  const later = { type: "interval", everyMinutes: 1_440, anchorAt: Date.now() + 2 * 86_400_000 };
  await add(air, { name: "Air at every start", prompt: "Say hello from the Air.", botId: scout.id, runOnStartup: true, schedule: later, durationMinutes: 15 });
  const pip = (await imac("POST", "/api/bots", { name: "Pip", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await turn(imac, pip, "Hello Pip.");
  await add(imac, { name: "iMac at every start", prompt: "Say hello from the iMac.", botId: pip.id, runOnStartup: true, schedule: later, durationMinutes: 15 });
  const hook = (await imac("POST", "/api/webhooks", { name: "Orders", prompt: "File the order.", botId: pip.id })).body;
  await expect.poll(() => idle(air), { timeout: 60_000, interval: 200 }).toBe(true);
  await expect.poll(() => idle(imac), { timeout: 60_000, interval: 200 }).toBe(true);

  // Both move to the same My Cloud, one after the other; each tells the Admin once, as itself, that its move is done.
  const reports = { air: [] as string[], imac: [] as string[] };
  fx.account.reportMove = async ({ installation }) => { reports.air.push(installation); return true; };
  studio.account.reportMove = async ({ installation }) => { reports.imac.push(installation); return true; };
  const movable = { status: "ready", origin: fx.cloudBase, moves: true };
  fx.account.state = { ...fx.account.state, deviceId: "device-air", machine: movable };
  await moveUntilDone(fx.oneHome, fx.journalFile);
  studio.account.state = { ...studio.account.state, deviceId: "device-imac", machine: movable };
  await moveUntilDone(studio.oneHome, studio.journalFile);
  expect([reports.air.length, reports.imac.length]).toEqual([1, 1]);
  expect(reports.air[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(reports.air[0]).not.toBe(reports.imac[0]);
  // The Air signs out and in again: a new sign-in, the same computer, told again.
  fx.account.state = { ...fx.account.state, deviceId: "device-air-2" };
  await fx.oneHome.kick();
  expect(reports.air).toEqual([reports.air[0], reports.air[0]]);
  const imacCopy = read(studio.journalFile)!.frozenAt!;
  expect([(await air("GET", "/api/move/freeze")).body.frozen, (await imac("GET", "/api/move/freeze")).body.frozen]).toEqual([true, true]);
  // On My Cloud since: a turn with each computer's bot.
  await turn(fx.onCloud, scout, "From My Cloud: book the venue.");
  await turn(fx.onCloud, pip, "From My Cloud: order more paper.");
  const cloudRows = { scout: (await rows(fx.onCloud, scout.threadId)).map((row) => row.id), pip: (await rows(fx.onCloud, pip.threadId)).map((row) => row.id) };

  // The trial ends unpaid: the Admin holds My Cloud and names the Air, the moved computer used most recently, as where
  // things come home; it signs in again once more meanwhile.
  const hold = { until: Date.now() + 3 * 86_400_000, homecoming: { installationId: reports.air[0], name: "MacBook Air" } };
  fx.account.state = { ...fx.account.state, deviceId: "device-air-3", machine: { status: "stopped", hold } };
  studio.account.state = { ...studio.account.state, machine: { status: "stopped", hold } };
  const asked = { air: 0, imac: 0 };
  fx.account.exportHome = async (options) => {
    asked.air++;
    expect(options?.installation, "the Air asks as itself").toBe(reports.air[0]);
    // Home again, the Air's routine that runs at every start began at once, and still runs as My Cloud's backup is taken.
    await expect.poll(async () => (await routines(air)).runs.some((run) => run.triggerSource === "startup" && run.status === "running"), { timeout: 30_000, interval: 100 }).toBe(true);
    return { grant: { origin: fx.cloudBase, code: (await fx.grant("Bring My Cloud home")).code, expiresAt: Date.now() + 300_000 } };
  };
  studio.account.exportHome = async () => { asked.imac++; throw Object.assign(new Error("Your bots came back to MacBook Air."), { status: 403, code: "not_homecoming" }); };
  await fx.relaunch({ kill: false, cloud: { OMB_CLOUD_EXPORT_ONLY: "1" } });
  const ended = Date.now();

  // The iMac: its own copy, as it was at the move, open again with every automation off; nothing from My Cloud.
  await studio.oneHome.kick();
  expect(read(studio.journalFile)).toMatchObject({ phase: "back", elsewhere: { name: "MacBook Air", since: imacCopy } });
  expect(studio.oneHome.view()).toEqual({ phase: "back", elsewhere: { name: "MacBook Air", since: imacCopy } });
  expect((await imac("GET", "/api/move/freeze")).body.frozen).toBe(false);
  expect((await routines(imac)).routines.map((routine) => [routine.name, routine.enabled])).toEqual([["iMac at every start", false]]);
  expect(((await imac("GET", "/api/webhooks")).body.webhooks as Array<{ enabled: boolean }>).map((entry) => entry.enabled)).toEqual([false]);
  const imacHooks = `http://127.0.0.1:${Number(new URL(studio.base).port) + 1}`;
  expect((await fetch(`${imacHooks}/hooks/${hook.webhook.endpointId}/${hook.credential.secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).ok,
    "its webhook takes nothing").toBe(false);
  expect([asked.imac, studio.spies.relaunches, studio.spies.phoneStarts]).toEqual([0, 0, 0]);
  expect(studio.spies.opened.at(-1)).toBe("local");
  expect((await rows(imac, pip.threadId)).map((row) => row.id), "My Cloud's later chat stays with the Air").not.toEqual(expect.arrayContaining(cloudRows.pip));
  // The person is not locked out of it.
  await turn(imac, pip, "Still here?");
  // Opened again later, it still starts nothing and asks My Cloud for nothing.
  await studio.relaunch({ kill: false });
  await studio.oneHome.kick();
  expect(asked.imac).toBe(0);

  // The Air: exactly the come-home one computer alone gets. Its restore waits for its own routine, seconds, not minutes.
  writeFileSync(HOLD, "");
  await fx.oneHome.kick();
  expect(read(fx.journalFile)?.phase, said(fx.journalFile)).toBe("home-again");
  expect(read(fx.journalFile)!.retryAt! - Date.now(), said(fx.journalFile)).toBeLessThan(15_000);
  rmSync(HOLD);
  writeFileSync(RELEASE, "");
  for (let round = 0; round < 40 && read(fx.journalFile)?.phase !== "back"; round++) { await fx.oneHome.kick(); if (read(fx.journalFile)?.phase !== "back") await sleep(500); }
  expect(read(fx.journalFile)?.phase, said(fx.journalFile)).toBe("back");
  expect(fx.spies.relaunches).toBe(1);
  await fx.relaunch({ kill: false });
  await fx.oneHome.kick();
  expect(fx.oneHome.view()).toEqual({ phase: "back" });
  const home = { scout: (await rows(air, scout.threadId)).map((row) => row.id), pip: (await rows(air, pip.threadId)).map((row) => row.id) };
  expect(home.scout).toEqual(expect.arrayContaining(cloudRows.scout));
  expect(home.pip, "the iMac's bot, with its chats from My Cloud, comes home to the Air").toEqual(expect.arrayContaining(cloudRows.pip));
  expect((await routines(air)).routines.map((routine) => [routine.name, routine.enabled]).sort()).toEqual([["Air at every start", true], ["iMac at every start", true]]);
  expect(asked.air).toBeGreaterThanOrEqual(1);
  // Its automations run: opened again, both routines that run at every start do, there.
  await fx.relaunch({ kill: false });
  await expect.poll(() => ranSince(air, ended), { timeout: 30_000, interval: 250 }).toEqual(expect.arrayContaining(["Air at every start", "iMac at every start"]));

  // The schedules on all three: nothing ran on the iMac since My Cloud ended, nor on the held Cloud, and so no routine on
  // two of them.
  await sleep(2_000);
  expect(await ranSince(imac, ended)).toEqual([]);
  expect(await ranSince(fx.onCloud, ended)).toEqual([]);
}, hostTimeout(900_000));
