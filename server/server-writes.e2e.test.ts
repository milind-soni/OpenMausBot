// The real server killed in the middle of a turn: what the files hold is what a later start reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fixture: VerificationServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const read = (path: string) => {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
};
const json = (path: string) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

it.each(["SIGKILL", "SIGTERM"] as const)("a turn and a routine run cut by %s keep everything saved so far", async (signal) => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir } = fixture.info;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, path).toBeLessThan(300);
    return await response.json() as any;
  };
  const { bot } = await cli("new-bot", "--name", "Talks");
  const { bot: worker } = await cli("new-bot", "--name", "Works");
  const task = (id: string, threadId: string) => (json(join(dataDir, "bots.json")) as any[] | null)?.find((row) => row.id === id)?.tasks?.find((row: any) => row.threadId === threadId);

  const { routine } = await api("POST", "/api/routines", { name: "Morning", prompt: "Summarise.", botId: worker.id, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  const { run } = await api("POST", `/api/routines/${routine.id}/run`);
  const savedRun = () => (json(join(dataDir, "routines.json")) as { runs?: any[] } | null)?.runs?.find((row) => row.id === run.id);
  await expect.poll(() => savedRun()?.status, { timeout: hostTimeout(30_000) }).toBe("running");

  await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Plan the offsite");
  await expect.poll(() => Object.keys(task(bot.id, bot.activeTaskId)?.resumeCursors ?? {}).length, { timeout: hostTimeout(30_000) }).toBe(1);

  await waitForExit(fixture.child, { signal });

  const saved = task(bot.id, bot.activeTaskId);
  expect(saved.title).toBe("Plan the offsite");
  expect(saved.askedAt).toEqual(expect.any(Number));
  expect(saved.cwd).toEqual(expect.any(String));
  expect(saved.resumeCursors.claude).toEqual(expect.any(String));
  expect(savedRun()).toMatchObject({ status: "running", threadId: expect.any(String) });

  const native = read(join(dataDir, "native", `${bot.activeTaskId}.ndjson`)).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  expect(JSON.stringify(native.filter((row) => row.dir === "out"))).toContain("Plan the offsite");
  // An orderly exit writes the lines still held; a kill can lose only those, the last FLUSH_MS of what the engine said.
  if (signal === "SIGTERM") expect(native.some((row) => row.dir === "in" && row.msg?.subtype === "init")).toBe(true);
}, hostTimeout(90_000));
