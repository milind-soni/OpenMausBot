import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("recovers queued/due work and a waiting routine's imported hand-off after restart", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.ok, `${method} ${path}`).toBe(true);
      return await response.json() as any;
    } catch (cause) {
      throw new Error(`${method} ${path} failed after ${Date.now() - startedAt}ms (${restarted ? "after" : "before"} restart)`, { cause });
    }
  };
  try {
    const scheduledBot = (await api("POST", "/api/bots", { name: "Restart scheduled" })).bot;
    const cronBot = (await api("POST", "/api/bots", { name: "Restart cron" })).bot;
    const queuedBot = (await api("POST", "/api/bots", { name: "Restart queued" })).bot;
    const interruptedBot = (await api("POST", "/api/bots", { name: "Waiting routine" })).bot;
    const orphanPeer = (await api("POST", "/api/bots", { name: "Waiting routine's peer" })).bot;
    const reusedBot = (await api("POST", "/api/bots", { name: "Reused routine conversation" })).bot;
    const reusedPeer = (await api("POST", "/api/bots", { name: "New user handoff peer" })).bot;
    await api("POST", `/api/bots/${reusedBot.id}/messages`, { text: "A later user request that owns its own pending handoff." });
    await runControlOmb(["wait", "--bot", reusedBot.id, "--task", reusedBot.threadId, "--url", url]);
    const scheduled = (await api("POST", "/api/routines", {
      name: "Due at startup", prompt: "Report after the restart", botId: scheduledBot.id,
      schedule: { type: "once", at: Date.now() + 60 * 60_000 },
    })).routine;
    const cron = (await api("POST", "/api/routines", {
      name: "Cron due at startup", prompt: "Recover one cron run, not every missed minute", botId: cronBot.id,
      enabled: false,
      schedule: { type: "cron", expression: "* * * * *", timeZone: "UTC" },
    })).routine;
    const manual = (await api("POST", "/api/routines", {
      name: "Queued before restart", prompt: "Finish the queued request", botId: queuedBot.id,
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).routine;
    const interrupted = (await api("POST", "/api/routines", {
      name: "Waiting on peer work", prompt: "Resume once the peer reports", botId: interruptedBot.id,
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).routine;
    const startupBot = (await api("POST", "/api/bots", { name: "Restart on startup" })).bot;
    const onStartup = (await api("POST", "/api/routines", {
      name: "Runs when the app starts", prompt: "Report once at startup", botId: startupBot.id,
      runOnStartup: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 2 * 24 * 60 * 60_000 },
    })).routine;
    expect(onStartup.runOnStartup).toBe(true);
    expect((await api("GET", "/api/routines")).runs.some((run: RoutineRun) => run.routineId === onStartup.id)).toBe(false);
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    // The original child is gone; only its owned temporary store is edited.
    const file = join(dataDir, "routines.json");
    const scheduler = new RoutineManager({
      file, botState: () => "busy", createTask: () => null, startTurn: async () => {},
    });
    const queued = scheduler.runNow(manual.id)!;
    await scheduler.tick();
    expect(scheduler.listRuns().find((run) => run.id === queued.id)?.status).toBe("queued");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.startupLaunchId = "previous-desktop-launch";
    const dueAt = Date.now() - 1_000;
    const cronDueAt = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
    disk.routines.find((routine: { id: string }) => routine.id === cron.id).enabled = true;
    disk.routines.find((routine: { id: string }) => routine.id === cron.id).nextRunAt = cronDueAt;
    disk.routines.find((routine: { id: string }) => routine.id === scheduled.id).schedule.at = dueAt;
    disk.routines.find((routine: { id: string }) => routine.id === scheduled.id).nextRunAt = dueAt;
    disk.runs.push({
      id: "interrupted-run", routineId: interrupted.id, routineName: interrupted.name,
      prompt: interrupted.prompt, target: "bot", botId: interruptedBot.id, runOn: "maus",
      scheduledFor: dueAt, createdAt: dueAt, startedAt: dueAt, manual: true,
      status: "waiting", threadId: interruptedBot.threadId,
    });
    disk.runs.push({
      id: "historical-run", routineId: "historical-routine", routineName: "Previously completed work",
      prompt: "Already finished", target: "bot", botId: reusedBot.id, runOn: "maus",
      scheduledFor: dueAt - 60_000, createdAt: dueAt - 60_000, startedAt: dueAt - 60_000,
      finishedAt: dueAt - 60_000, manual: true, status: "completed", threadId: reusedBot.threadId,
    });
    writeFileSync(file, JSON.stringify(disk));
    // The legacy ledger as the last process left it: one queued hand-off per source thread.
    writeFileSync(join(dataDir, "delegations.json"), JSON.stringify({
      [interruptedBot.threadId]: [{
        id: "orphan-handoff", sourceBotId: interruptedBot.id, toBotId: orphanPeer.id,
        message: "This waiting routine's hand-off survives the restart", depth: 0, attempts: 0,
      }],
      [reusedBot.threadId]: [{
        id: "later-user-handoff", sourceBotId: reusedBot.id, toBotId: reusedPeer.id,
        message: "This later user request must survive the restart", depth: 0, attempts: 0,
      }],
    }));

    // Reuse the fixture home, never the parent's CLI accounts or app state.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
      PATH: dirname(process.execPath), FAKE_CLAUDE_MODE: "happy",
      OMB_DESKTOP_LAUNCH_ID: "previous-desktop-launch",
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    const deadline = Date.now() + 30_000;
    let runs: RoutineRun[] = [];
    while (Date.now() < deadline) {
      expect(restarted.exitCode, `restarted server exited; see ${logPath}`).toBeNull();
      try {
        runs = (await api("GET", "/api/routines")).runs;
        if ([scheduled.id, manual.id, cron.id, interrupted.id, onStartup.id].every((id) => runs.some((run) => run.routineId === id && run.status === "completed"))) break;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(runs, readFileSync(logPath, "utf8").slice(-4_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({ routineId: scheduled.id, scheduledFor: dueAt, status: "completed" }),
      expect.objectContaining({ routineId: cron.id, scheduledFor: cronDueAt, status: "completed" }),
      expect.objectContaining({ id: queued.id, routineId: manual.id, status: "completed" }),
      expect.objectContaining({ routineId: onStartup.id, triggerSource: "startup", status: "completed" }),
      expect.objectContaining({ id: "interrupted-run", status: "completed" }),
    ]));
    expect(runs.filter(run => run.routineId === onStartup.id)).toHaveLength(1);
    const resumedRun = runs.find((run) => run.id === "interrupted-run")!;
    expect(resumedRun.error).toBeUndefined();
    expect(resumedRun.finishedAt).toBeGreaterThan(dueAt);
    // The fake answers every turn with the same words, so the resume shows in the run's conversation.
    const resumedThread = (await api("GET", `/api/threads/${interruptedBot.threadId}/messages?limit=100`)).messages as Array<{ tool?: { name?: string }; from?: { botId?: string } }>;
    expect(resumedThread.some((message) => message.tool?.name === "Waiting routine's peer replied" && message.from?.botId === orphanPeer.id)).toBe(true);
    expect(resumedThread.some((message) => message.tool?.name?.startsWith("Resumed with Waiting routine's peer results"))).toBe(true);
    expect(runs.filter(run => run.routineId === cron.id && run.scheduledFor < Math.floor(Date.now() / 60_000) * 60_000)).toHaveLength(1);
    const restoredCron = (await api("GET", "/api/routines")).routines.find((routine: { id: string }) => routine.id === cron.id);
    expect(restoredCron.schedule).toEqual(cron.schedule);
    expect(restoredCron.nextRunAt).toBeGreaterThan(Date.now());
    const recoveredPeer = (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === orphanPeer.id);
    expect(recoveredPeer.messages.some((message: { text?: string }) => message.text?.includes("This waiting routine's hand-off survives the restart"))).toBe(true);
    await expect.poll(async () => Boolean((await api("GET", "/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === orphanPeer.id).busy), { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => {
      const current = (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === reusedPeer.id);
      return current.messages.some((message: { text?: string }) => message.text?.includes("This later user request must survive the restart"));
    }, { timeout: 15_000 }).toBe(true);
    expect(existsSync(join(dataDir, "delegations.json"))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(dataDir, "delegations.json.migrated"), "utf8"))).sort())
      .toEqual([interruptedBot.threadId, reusedBot.threadId].sort());
    await expect.poll(() => readHandoffs(dataDir).find((node) => node.id === "orphan-handoff")?.status, { timeout: 15_000 }).toBe("completed");
    await expect.poll(() => readHandoffs(dataDir).find((node) => node.id === "later-user-handoff")?.status, { timeout: 15_000 }).toBe("completed");
    expect(readHandoffs(dataDir).find((node) => node.id === "orphan-handoff")).toMatchObject({ botId: orphanPeer.id, threadId: orphanPeer.threadId, mode: "work", reply: "resume" });
    await expect.poll(() => readHandoffs(dataDir).find((node) => node.id === `legacy-${interruptedBot.threadId}`)?.status, { timeout: 15_000 }).toBe("completed");
    await expect.poll(() => readHandoffs(dataDir).find((node) => node.id === `legacy-${reusedBot.threadId}`)?.status, { timeout: 15_000 }).toBe("completed");
    const scheduledRun = runs.find((run) => run.routineId === scheduled.id)!;
    const wait = await runControlOmb(["wait", "--bot", scheduledBot.id, "--task", scheduledRun.threadId!, "--url", url]);
    const messages = await runControlOmb(["messages", "--bot", scheduledBot.id, "--task", scheduledRun.threadId!, "--url", url]);
    expect(wait).toMatchObject({ status: "settled" });
    const evidence = { fixture: fixture.info, restartPid: restarted.pid, runs, wait, messages };
    writeFileSync(`${logPath}.routines-restart.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath: `${logPath}.routines-restart.json` }));
  } catch (error) {
    // CI must retain the owned fixture's diagnostics, not only a fetch timeout.
    try { console.error(`Routine startup fixture ${logPath}\n${readFileSync(logPath, "utf8").slice(-8_000)}`); }
    catch {}
    throw error;
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 60_000);
