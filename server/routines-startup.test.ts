import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("recovers queued/due work without resurrecting an interrupted routine after restart", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return await response.json() as any;
  };
  try {
    const scheduledBot = (await api("POST", "/api/bots", { name: "Restart scheduled" })).bot;
    const queuedBot = (await api("POST", "/api/bots", { name: "Restart queued" })).bot;
    const interruptedBot = (await api("POST", "/api/bots", { name: "Interrupted routine" })).bot;
    const orphanPeer = (await api("POST", "/api/bots", { name: "Orphan peer" })).bot;
    const reusedBot = (await api("POST", "/api/bots", { name: "Reused routine conversation" })).bot;
    const reusedPeer = (await api("POST", "/api/bots", { name: "New user handoff peer" })).bot;
    await api("POST", `/api/bots/${reusedBot.id}/messages`, { text: "A later user request that owns its own pending handoff." });
    await runControlOmb(["wait", "--bot", reusedBot.id, "--task", reusedBot.threadId, "--url", url]);
    const scheduled = (await api("POST", "/api/routines", {
      name: "Due at startup", prompt: "Report after the restart", botId: scheduledBot.id,
      schedule: { type: "once", at: Date.now() + 60 * 60_000 },
    })).routine;
    const manual = (await api("POST", "/api/routines", {
      name: "Queued before restart", prompt: "Finish the queued request", botId: queuedBot.id,
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).routine;
    const interrupted = (await api("POST", "/api/routines", {
      name: "Interrupted peer work", prompt: "Do not resume after recovery", botId: interruptedBot.id,
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).routine;
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
    const dueAt = Date.now() - 1_000;
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
    writeFileSync(join(dataDir, "delegations.json"), JSON.stringify({
      [interruptedBot.threadId]: [{
        id: "orphan-handoff", sourceBotId: interruptedBot.id, toBotId: orphanPeer.id,
        message: "This stopped routine must not launch peer work", depth: 0, attempts: 0,
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
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    const deadline = Date.now() + 20_000;
    let runs: RoutineRun[] = [];
    while (Date.now() < deadline) {
      expect(restarted.exitCode, `restarted server exited; see ${logPath}`).toBeNull();
      try {
        runs = (await api("GET", "/api/routines")).runs;
        if ([scheduled.id, manual.id].every((id) => runs.some((run) => run.routineId === id && run.status === "completed"))) break;
      } catch {
        // The exact replacement child is still starting its listener.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(runs, readFileSync(logPath, "utf8").slice(-4_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({ routineId: scheduled.id, scheduledFor: dueAt, status: "completed" }),
      expect.objectContaining({ id: queued.id, routineId: manual.id, status: "completed" }),
      expect.objectContaining({ id: "interrupted-run", status: "failed", error: expect.stringContaining("restarted") }),
    ]));
    const recoveredPeer = (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === orphanPeer.id);
    expect(recoveredPeer.messages.some((message: { role: string }) => message.role === "user")).toBe(false);
    expect(Boolean(recoveredPeer.busy)).toBe(false);
    await expect.poll(async () => {
      const current = (await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === reusedPeer.id);
      return current.messages.some((message: { role: string; text?: string }) =>
        message.role === "user" && message.text?.includes("This later user request must survive the restart"));
    }, { timeout: 15_000 }).toBe(true);
    await expect.poll(
      () => JSON.parse(readFileSync(join(dataDir, "delegations.json"), "utf8")),
      { timeout: 10_000 },
    ).toEqual({});
    const scheduledRun = runs.find((run) => run.routineId === scheduled.id)!;
    const wait = await runControlOmb(["wait", "--bot", scheduledBot.id, "--task", scheduledRun.threadId!, "--url", url]);
    const messages = await runControlOmb(["messages", "--bot", scheduledBot.id, "--task", scheduledRun.threadId!, "--url", url]);
    expect(wait).toMatchObject({ status: "settled" });
    const evidence = { fixture: fixture.info, restartPid: restarted.pid, runs, wait, messages };
    writeFileSync(`${logPath}.routines-restart.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath: `${logPath}.routines-restart.json` }));
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 45_000);
