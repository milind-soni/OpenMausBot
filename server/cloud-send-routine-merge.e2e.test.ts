// A routine both sides hold and both changed, as after an earlier copy of the whole workspace, in the one-time move to
// the person's own Cloud: one routine whose definition is the one changed last and whose runs are both sides', so the
// move's check passes. This computer's server and a Cloud home (scripts/testing/cloud-send-fixture.ts) with main's own
// wiring between them. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-routines-${randomBytes(8).toString("hex")}` });
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

type Side = CloudSendFixture["local"];
type Routines = { routines: Array<{ id: string; prompt: string; updatedAt: number }>; runs: Array<{ id: string; routineId: string; status: string }> };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
const routines = async (side: Side) => (await side("GET", "/api/routines")).body as Routines;
const prompt = async (side: Side, id: string) => (await routines(side)).routines.filter((routine) => routine.id === id).map((routine) => routine.prompt);
const runIds = async (side: Side, id: string) => (await routines(side)).runs.filter((run) => run.routineId === id && run.status === "completed").map((run) => run.id).sort();
const NO_GAPS = { items: [], parts: [], memory: [], rooms: [], connections: [], conversations: [], files: [], runs: [], journal: [], learned: [], teams: [], settings: [] };

/** One run of a routine here, finished. */
async function ranHere(id: string) {
  const before = (await runIds(fx.local, id)).length;
  expect((await fx.local("POST", `/api/routines/${id}/run`)).status).toBeLessThan(300);
  await expect.poll(async () => (await runIds(fx.local, id)).length, { timeout: 60_000, interval: 250 }).toBe(before + 1);
  await expect.poll(() => idle(fx.local), { timeout: 30_000, interval: 100 }).toBe(true);
}

/** A change to a routine's prompt on one side, a moment after the last one anywhere, so the two sides' times differ. */
async function changed(side: Side, id: string, text: string) {
  await sleep(20);
  expect((await side("PATCH", `/api/routines/${id}`, { prompt: text })).status).toBe(200);
}

it("a routine changed on both sides is one routine with the definition changed last and both sides' runs; the check passes, and runs made here later never undo My Cloud's", async () => {
  const { local, onCloud } = fx;
  const nova = (await local("POST", "/api/bots", { name: "Nova", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
  const add = async (name: string) => {
    const made = (await local("POST", "/api/routines", { name, prompt: `${name}.`, botId: nova.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).body;
    return (made.routine ?? made).id as string;
  };
  const digest = await add("Digest"), sweep = await add("Sweep");

  // An earlier copy of the whole workspace left Nova and both routines on My Cloud, with nothing recorded of what went.
  expect((await onCloud("POST", "/api/bots", { id: nova.id, threadId: nova.threadId, name: "Nova", useDefaults: false })).status).toBeLessThan(300);
  for (const id of [digest, sweep]) {
    const held = (await local("GET", `/api/cloud-send/kind?key=routine:${id}`)).body;
    expect((await onCloud("PUT", "/api/cloud-send/kind", { v: 1, key: `routine:${id}`, dataDir: held.dataDir, record: held.record })).status).toBe(200);
  }
  // Since: each ran here, and each changed on both sides. Digest changed here last, Sweep on My Cloud.
  await ranHere(digest);
  await ranHere(sweep);
  await changed(onCloud, digest, "Digest, as My Cloud has it.");
  await changed(local, digest, "Digest, as this computer has it.");
  await changed(local, sweep, "Sweep, as this computer has it.");
  await changed(onCloud, sweep, "Sweep, as My Cloud has it.");
  const ranOnCloud = await runIds(onCloud, sweep);

  const first = await fx.move();
  expect(first.result.failed, JSON.stringify(first.result.failed)).toEqual([]);
  expect((await fx.move({ final: true })).result.failed).toEqual([]);
  const report = await fx.check();
  expect(report.gaps, JSON.stringify(report.gaps)).toEqual(NO_GAPS);
  expect(report.ok).toBe(true);

  expect(await prompt(onCloud, digest), "one routine, this computer's change being the later one").toEqual(["Digest, as this computer has it."]);
  expect(await prompt(onCloud, sweep), "one routine, My Cloud's change being the later one").toEqual(["Sweep, as My Cloud has it."]);
  for (const id of [digest, sweep]) expect(await runIds(onCloud, id)).toEqual(expect.arrayContaining(await runIds(local, id)));
  expect(await runIds(onCloud, sweep)).toEqual(expect.arrayContaining(ranOnCloud));

  // Before this computer stops: Sweep runs here again, and Digest changes here once more. The final pass carries the run
  // without undoing My Cloud's Sweep, and Digest's change, made only here since it went.
  await ranHere(sweep);
  await changed(local, digest, "Digest, changed here again.");
  expect((await fx.move({ final: true })).result.failed).toEqual([]);
  expect(await prompt(onCloud, sweep)).toEqual(["Sweep, as My Cloud has it."]);
  expect(await prompt(onCloud, digest)).toEqual(["Digest, changed here again."]);
  expect(await runIds(onCloud, sweep)).toEqual(expect.arrayContaining(await runIds(local, sweep)));
  const again = await fx.check();
  expect(again.gaps, JSON.stringify(again.gaps)).toEqual(NO_GAPS);
  expect(again.ok).toBe(true);
}, hostTimeout(300_000));
