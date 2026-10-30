// The one-time move when its check can't pass: this computer's server and a Cloud home
// (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them, and My Cloud's check route failing until
// it answers again. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CloudSendNotice } from "../electron/cloud-send.mjs";
import { FAILING_LINE_MS, FROZEN_RETRY_MS } from "../electron/one-home.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-retry-${randomBytes(8).toString("hex")}` });
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

type Side = CloudSendFixture["local"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const journal = () => { try { return JSON.parse(readFileSync(fx.journalFile, "utf8")) as Record<string, any>; } catch { return null; } };
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function answered(side: Side, bot: { id: string; threadId: string }, text: string) {
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => idle(side), { timeout: 60_000, interval: 100 }).toBe(true);
}

it("a check that can't pass lifts the freeze and tries again in an hour, with nothing switched on; a day of it offers Try again, which finishes the move", async () => {
  const { local, onCloud } = fx;
  const juno = (await local("POST", "/api/bots", { name: "Juno", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
  await answered(local, juno, "Hello Juno.");
  const made = (await local("POST", "/api/routines", { name: "Daily", prompt: "Report.", botId: juno.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).body;
  const daily = (made.routine ?? made).id as string;

  // My Cloud's chats check fails: a gateway that answers 503.
  fx.intercept = (url) => (url.endsWith("/api/cloud-send/chats/verify") ? new Response(JSON.stringify({ error: "Bad gateway" }), { status: 503, headers: { "content-type": "application/json" } }) : null);
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  const started = Date.now();
  for (let round = 0; round < 120 && !journal()?.retryAt; round++) { await fx.oneHome.kick(); if (!journal()?.retryAt) await sleep(250); }
  expect(journal()).toMatchObject({ phase: "copy", passes: 0, tries: 1 });
  expect(journal()!.frozenAt, "it did freeze before the check").toBeGreaterThanOrEqual(started);
  expect(journal()!.retryAt - Date.now()).toBeGreaterThan(FROZEN_RETRY_MS - 60_000);

  // This computer is home again as it was: not frozen, and its bots answer.
  expect((await local("GET", "/api/move/freeze")).body.frozen).toBe(false);
  await answered(local, juno, "Still here?");
  // Nothing was switched on at My Cloud, and nothing runs there.
  const there = (await onCloud("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean }>;
  expect(there.find((routine) => routine.id === daily)?.enabled).toBe(false);
  expect(fx.oneHome.away()).toBe(false);
  // Before the hour is up, nothing tries again.
  await fx.oneHome.kick();
  expect(journal()!.tries).toBe(1);

  // A day of failing: the line says so, with Try again, on this computer's page.
  const kept = journal()!;
  writeFileSync(fx.journalFile, JSON.stringify({ ...kept, failingSince: Date.now() - FAILING_LINE_MS - 1 }));
  const notice = await fx.call<CloudSendNotice>("cloud-send:notice", "local");
  expect(notice.move).toMatchObject({ phase: "copy", failing: { error: expect.any(String) } });

  fx.intercept = null;
  const after = await fx.call<CloudSendNotice>("cloud-send:move-retry", "local");
  expect(journal()?.phase).toBe("done");
  expect(after.move).toMatchObject({ phase: "done" });
  expect(((await onCloud("GET", "/api/routines")).body.routines as Array<{ id: string; enabled: boolean }>).find((routine) => routine.id === daily)?.enabled).toBe(true);
  expect((await local("POST", `/api/bots/${juno.id}/messages`, { text: "Once more?", threadId: juno.threadId })).status).toBe(409);
}, hostTimeout(600_000));
