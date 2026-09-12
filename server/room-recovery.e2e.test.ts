import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("boots and reports an interrupted routine back to its source room", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Recovery lead", "--url", url]) as any;
    const { channel } = await handleToolCall("create_channel", { name: "Recovery room", member_ids: [bot.id] },
      (path, options) => request(path, options, url)) as any;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    // Reproduce the persisted state of an interrupted process, not a second
    // live writer. Recovery must emit its group/card changes during startup.
    writeFileSync(join(dataDir, "routines.json"), JSON.stringify({ version: 1, routines: [], runs: [{
      id: "interrupted-room-run", routineId: "interrupted-routine", routineName: "Room report",
      botId: bot.id, target: "bot", runOn: "maus", sourceThreadId: channel.activeTaskId,
      status: "running", prompt: "Report once", createdAt: Date.now(), scheduledFor: Date.now(),
    }] }));
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
    await expect.poll(async () => {
      if (restarted?.exitCode !== null) throw new Error(readFileSync(logPath, "utf8"));
      return fetch(url + "/api/health").then(r => r.ok).catch(() => false);
    }, { timeout: 10_000, interval: 150 }).toBe(true);
    const { runs } = await request("/api/routines", {}, url) as any;
    expect(runs[0]).toMatchObject({ status: "failed", error: "OpenMausBot restarted while this routine was running" });
    const { messages } = await request(`/api/threads/${channel.activeTaskId}/messages`, {}, url) as any;
    expect(messages.filter((m: any) => m.routineRun?.runId === "interrupted-room-run"))
      .toMatchObject([{ routineRun: { status: "failed" } }]);
    const { groups } = await request("/api/bots", {}, url) as any;
    expect(groups.find((g: any) => g.id === channel.id).working).toBe(false);
    // Store deliberately catches subscriber exceptions, so a healthy server
    // alone does not prove that recovery broadcasts were safe.
    expect(readFileSync(logPath, "utf8")).not.toMatch(/ReferenceError|store: change listener threw/);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 30_000);
