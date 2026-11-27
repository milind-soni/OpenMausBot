import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlOmb } from "../scripts/control-omb.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";

// Automations on a real server, through the calls the Automations page makes: switched off and back on, both kinds work
// and a schedule runs on time afterwards; a one-time schedule whose time passed says so instead of running again; a
// deleted bot's automations go with it and never run; automations whose bot is already gone are removed at the next
// start.
it("turns schedules and webhooks back on, removes a deleted bot's automations, and clears orphans at start", async () => {
  const server = await launchRestartableServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const newBot = async (name: string) => ((await runControlOmb(["new-bot", "--name", name, "--url", server.url])) as { bot: { id: string } }).bot.id;
  const state = async () => ({ ...(await api("GET", "/api/routines")), ...(await api("GET", "/api/webhooks")) }) as { routines: any[]; runs: any[]; webhooks: any[] };
  const send = (address: string, body: unknown) => fetch(address, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const scout = await newBot("Scout");
    const gone = await newBot("Gone");
    const old = await newBot("Old");
    // One instant for every schedule, far enough ahead for everything below to happen first.
    const dueAt = Date.now() + 50_000;
    const every = (botId: string, name: string) => api("POST", "/api/routines", { name, prompt: `${name}: reply with one line.`, botId, schedule: { type: "interval", everyMinutes: 60, anchorAt: dueAt } }, 201);
    const hook = (botId: string, name: string) => api("POST", "/api/webhooks", { name, prompt: `${name}: reply with one line.`, botId }, 201);
    const { routine } = await every(scout, "Morning summary");
    const scoutHook = await hook(scout, "Sales form leads");
    const goneRoutine = (await every(gone, "Gone summary")).routine;
    const goneHook = await hook(gone, "Gone leads");
    const oldRoutine = (await every(old, "Old summary")).routine;
    const oldHook = await hook(old, "Old leads");

    // 1. A schedule: off, then on, from the switch's own call. It comes back with its next time.
    expect((await api("PATCH", `/api/routines/${routine.id}`, { enabled: false })).routine).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await api("PATCH", `/api/routines/${routine.id}`, { enabled: true })).routine).toMatchObject({ enabled: true, nextRunAt: dueAt });

    // 2. A webhook: off turns calls away, on takes them again and runs.
    const address = scoutHook.credential.url as string;
    expect((await api("PATCH", `/api/webhooks/${scoutHook.webhook.id}`, { enabled: false, verificationPending: false })).webhook).toMatchObject({ enabled: false });
    expect((await send(address, { lead: "Mallory" })).status).toBe(409);
    expect((await api("PATCH", `/api/webhooks/${scoutHook.webhook.id}`, { enabled: true, verificationPending: false })).webhook).toMatchObject({ enabled: true });
    const accepted = await send(address, { lead: "Ada" });
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json() as { runId: string };
    await expect.poll(async () => (await state()).runs.find((run) => run.id === runId)?.status, { timeout: 30_000 }).toBe("completed");

    // 3. A one-time schedule whose time has passed is not switched back on to run again: it says why.
    const once = (await api("POST", "/api/routines", { name: "Reminder", prompt: "Remind me once.", botId: scout, schedule: { type: "once", at: Date.now() + 1_000 } }, 201)).routine;
    await expect.poll(async () => (await state()).routines.find((candidate) => candidate.id === once.id)?.enabled, { timeout: 30_000 }).toBe(false);
    await expect.poll(async () => (await state()).runs.filter((run) => run.routineId === once.id && run.status === "completed").length, { timeout: 30_000 }).toBe(1);
    expect((await api("PATCH", `/api/routines/${once.id}`, { enabled: true }, 400)).error).toBe("Its time has passed. Edit it to pick a new time.");
    expect((await state()).routines.find((candidate) => candidate.id === once.id)?.enabled).toBe(false);

    // 4. Deleting a bot from the app removes its schedules, its webhooks, their runs, and its address stops working.
    const before = await send(goneHook.credential.url, { lead: "Before" });
    expect(before.status).toBe(202);
    const beforeRun = (await before.json() as { runId: string }).runId;
    await expect.poll(async () => (await state()).runs.find((run) => run.id === beforeRun)?.status, { timeout: 30_000 }).toBe("completed");
    await api("DELETE", `/api/bots/${gone}`);
    let now = await state();
    expect(now.routines.map((candidate) => candidate.id)).not.toContain(goneRoutine.id);
    expect(now.webhooks.map((candidate) => candidate.id)).not.toContain(goneHook.webhook.id);
    expect(now.runs.filter((run) => run.botId === gone)).toEqual([]);
    expect((await send(goneHook.credential.url, { lead: "After" })).status).toBe(401);

    // 5. Automations on disk whose bot is gone are removed at the next start.
    await server.stop();
    const botsFile = join(server.dataDir, "bots.json");
    writeFileSync(botsFile, JSON.stringify((JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ id: string }>).filter((bot) => bot.id !== old)));
    expect(readFileSync(join(server.dataDir, "routines.json"), "utf8")).toContain(oldRoutine.id);
    await server.start();
    now = await state();
    expect(now.routines.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([routine.id, once.id]));
    expect(now.routines.map((candidate) => candidate.botId)).not.toContain(old);
    expect(now.webhooks.map((candidate) => candidate.id)).not.toContain(oldHook.webhook.id);
    expect(readFileSync(join(server.dataDir, "routines.json"), "utf8")).not.toContain(oldRoutine.id);
    expect(readFileSync(join(server.dataDir, "webhooks.json"), "utf8")).not.toContain(oldHook.webhook.id);

    // 6. The schedule switched back on runs at its time, across the restart; nothing runs for either deleted bot.
    await expect.poll(async () => (await state()).runs.find((run) => run.routineId === routine.id && !run.manual)?.status, { timeout: 90_000, interval: 1_000 }).toBe("completed");
    now = await state();
    expect(now.runs.find((run) => run.routineId === routine.id && !run.manual)).toMatchObject({ scheduledFor: dueAt });
    expect(now.runs.filter((run) => run.botId === gone || run.botId === old)).toEqual([]);
  } finally {
    console.info(JSON.stringify({ logPath: server.logPath }));
    await server.close();
  }
}, 240_000);
