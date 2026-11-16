// A routine's run that keeps going, through a real server and the fake Claude engine playing fourteen model calls, each
// one shell command, 600 ms apart. With the limits for turns nobody is watching switched off the engine makes all
// fourteen; with them set, the turn is stopped at the limit and the engine makes no call after it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const CALLS = 14;
const SAME_FAILURE = Array.from({ length: CALLS }, () => ({ name: "Bash", input: { command: "git status" }, ok: false, output: "fatal: not a git repository" }));
const DIFFERENT_CALLS = Array.from({ length: CALLS }, (_, index) => ({ name: "Bash", input: { command: `ls part-${index}` }, ok: true, output: "ok" }));
/** The last call holds, so a turn nothing stops stays open with every call made. */
const held = (calls: object[]) => JSON.stringify([...calls, { name: "Bash", input: { command: "sleep 600" }, hold: true }]);

let fixture: VerificationServer | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function launch(env: NodeJS.ProcessEnv) {
  scratch = mkdtempSync(join(tmpdir(), "omb-unattended-"));
  const script = join(scratch, "calls.json");
  fixture = await launchVerificationServer({ ...env, FAKE_CLAUDE_TOOL_CALLS_FILE: script, FAKE_CLAUDE_RELEASE: join(scratch, "release") });
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const bot = (await runControlOmb(["new-bot", "--name", "Night bot", "--url", url]) as any).bot;
  /** One run of a new routine playing `calls`: the run row, and the model calls the engine got to make. */
  const play = async (name: string, calls: object[], until: (run: any, made: number) => boolean) => {
    writeFileSync(script, held(calls));
    const { routine } = await api("POST", "/api/routines", { name, prompt: "Tidy the repository.", botId: bot.id, schedule: { type: "cron", expression: "0 3 * * *", timeZone: "Europe/London" } });
    await api("POST", `/api/routines/${routine.id}/run`);
    const run = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.routineId === routine.id);
    const rows = async () => { const row = await run(); return row?.threadId ? (await api("GET", `/api/threads/${row.threadId}/messages?limit=200`)).messages as any[] : []; };
    const made = async () => (await rows()).filter((message) => message.kind === "activity" && message.tool?.name === "Bash").length;
    await expect.poll(async () => until(await run(), await made()), { timeout: hostTimeout(60_000), interval: 250 }).toBe(true);
    // A call the engine was about to make would land within its 600 ms cadence.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { run: await run(), made: await made(), stops: (await rows()).flatMap((message) => failedTurnCause(message.tool?.name ?? "") ?? []) };
  };
  return { play };
}

it("with the limits off, a looping run makes every call it wants to", async () => {
  const { play } = await launch({ OMB_LOOP_GUARD_UNATTENDED_STOP_AT: "off", OMB_UNATTENDED_TURN_MAX_REQUESTS: "off" });
  const same = await play("Same failure", SAME_FAILURE, (_run, made) => made >= CALLS + 1);
  expect(same.made).toBe(CALLS + 1);
  expect(same.run.status).toBe("running");
  expect(same.stops).toEqual([]);
}, hostTimeout(120_000));

it("a run repeating one failure is stopped at the loop guard's count, and one that keeps going at its request limit, each with one line", async () => {
  const { play } = await launch({ OMB_LOOP_GUARD_UNATTENDED_STOP_AT: "6", OMB_UNATTENDED_TURN_MAX_REQUESTS: "10" });
  const loopStop = "the same call failed the same way 6 times in a row: “Bash: git status” — the turn was stopped";
  const same = await play("Same failure", SAME_FAILURE, (run) => run?.status === "failed");
  expect(same.made).toBe(6);
  expect(same.stops).toEqual([loopStop]);
  expect(same.run).toMatchObject({ status: "failed", error: `T${loopStop.slice(1)}` });

  const requestStop = "this turn had nobody waiting on it and made 10 requests to its AI, its limit — the turn was stopped";
  const going = await play("Keeps going", DIFFERENT_CALLS, (run) => run?.status === "failed");
  expect(going.made).toBe(10);
  expect(going.stops).toEqual([requestStop]);
  expect(going.run).toMatchObject({ status: "failed", error: `T${requestStop.slice(1)}` });
}, hostTimeout(180_000));
