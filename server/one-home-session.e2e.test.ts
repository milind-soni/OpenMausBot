// The one-time move's owner sessions at My Cloud against the Admin's limit on one-time codes (10 an account, and 10 a
// device, in 10 minutes): two computers of one account move at once, one killed twice on the way, the other failing once
// and going again. Each computer and its Cloud home (scripts/testing/cloud-send-fixture.ts) with main's own wiring
// between them. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-one-session-${randomBytes(8).toString("hex")}`;
const MOVE = "Move to My Cloud";
const TEN_MINUTES = 600_000;

/** The one-time codes the Admin gave for this account's Cloud, each redeemed as one owner session, and those it refused. */
const admin = { given: [] as Array<{ device: string; at: number }>, refused: [] as string[] };
/** A failure a test has My Cloud answer with instead, per computer. */
const faults = new Map<CloudSendFixture, (url: string) => Response | null>();

/** Main's requests to My Cloud for one computer, each new owner session counted against the Admin's limits on the codes
 * it gives for one account's Cloud (cloud-desktop.ts, cloud-machines.ts) and refused as the Admin refuses one over them. */
function throughAdmin(fx: CloudSendFixture, device: string) {
  fx.intercept = (url) => {
    if (!url.endsWith("/api/auth/pair")) return faults.get(fx)?.(url) ?? null;
    const now = Date.now(), recent = admin.given.filter((entry) => entry.at > now - TEN_MINUTES);
    if (recent.length < 10 && recent.filter((entry) => entry.device === device).length < 10) { admin.given.push({ device, at: now }); return null; }
    admin.refused.push(device);
    return new Response(JSON.stringify({ error: "Too many connection requests. Try again later." }), { status: 429, headers: { "content-type": "application/json" } });
  };
}

let laptop: CloudSendFixture, desk: CloudSendFixture;
beforeAll(async () => {
  [laptop, desk] = await Promise.all([launchCloudSendFixture({ onePasswordToken: TOKEN }), launchCloudSendFixture({ onePasswordToken: TOKEN })]);
  throughAdmin(laptop, "laptop");
  throughAdmin(desk, "desk");
}, hostTimeout(180_000));
afterAll(async () => { await Promise.all([laptop?.close(), desk?.close()]); });

type Side = CloudSendFixture["local"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const journal = (fx: CloudSendFixture) => (existsSync(fx.journalFile) ? JSON.parse(readFileSync(fx.journalFile, "utf8")) as { phase: string } | null : null);
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
const moveSessions = (fx: CloudSendFixture) => fx.sessions.filter((session) => session.label === MOVE).length;

/** A bot with a chat and a routine, on this computer only. */
async function seed(fx: CloudSendFixture, name: string) {
  const bot = (await fx.local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
  expect((await fx.local("POST", `/api/bots/${bot.id}/messages`, { text: "Plan the week.", threadId: bot.threadId })).status).toBe(202);
  await expect.poll(() => idle(fx.local), { timeout: 60_000, interval: 100 }).toBe(true);
  expect((await fx.local("POST", "/api/routines", { name: "Morning report", prompt: "Report.", botId: bot.id,
    schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).status).toBeLessThan(300);
}

/** Main's move, run as the app runs it until it is done: killed the moment each of `kills` would be written down, and
 * opened again. */
async function moveUntilDone(fx: CloudSendFixture, kills: string[]) {
  const left = new Set(kills);
  let killed = false;
  fx.beforeJournalWrite = (value) => { if (value?.phase && left.delete(value.phase)) { killed = true; throw new Error("the app was killed"); } };
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  for (let round = 0; round < 240 && journal(fx)?.phase !== "done"; round++) {
    await fx.oneHome.kick();
    if (killed) { killed = false; await fx.relaunch(); continue; }
    if (journal(fx)?.phase !== "done") await sleep(250);
  }
  fx.beforeJournalWrite = null;
  expect(journal(fx)?.phase, `${JSON.stringify(journal(fx))}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")}`).toBe("done");
  expect(left.size, "killed at each phase asked").toBe(0);
}

/** A move whose check fails once (My Cloud's gateway answers 503), so it waits to go again; then Try again finishes it. */
async function moveFailingOnce(fx: CloudSendFixture) {
  faults.set(fx, (url) => (url.endsWith("/api/cloud-send/chats/verify") ? new Response(JSON.stringify({ error: "Bad gateway" }), { status: 503 }) : null));
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  for (let round = 0; round < 120 && !(journal(fx) as { retryAt?: number } | null)?.retryAt; round++) { await fx.oneHome.kick(); await sleep(100); }
  expect(journal(fx)).toMatchObject({ phase: "copy", tries: 1 });
  faults.delete(fx);
  await fx.call("cloud-send:move-retry", "local");
  expect(journal(fx)?.phase).toBe("done");
}

it("a move killed twice and another computer's move that fails once stay within the Admin's codes: one session each time the app runs, signed out once done", async () => {
  await Promise.all([seed(laptop, "Scout"), seed(desk, "Ember")]);
  const started = Date.now();
  // Killed after its first pass went, and again after its final pass went with this computer frozen: as in the real app.
  await Promise.all([moveUntilDone(laptop, ["wait", "check"]), moveFailingOnce(desk)]);
  expect(Date.now() - started, "all of it within the Admin's 10 minutes").toBeLessThan(TEN_MINUTES);

  expect(admin.refused, `the Admin gave ${admin.given.length} codes`).toEqual([]);
  expect(moveSessions(laptop), "one session each time the app ran").toBe(3);
  expect(moveSessions(desk), "a move that waits to go again keeps its session").toBe(1);
  expect(admin.given.length).toBeLessThanOrEqual(4);

  // Done, the move signs its session out.
  const devices = (await desk.onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ label: string }>;
  expect(devices.filter((device) => device.label === MOVE)).toEqual([]);
}, hostTimeout(600_000));
