import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { RoutineRun } from "./routines.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("does not run a delivery twice after a process dies between the queue and ingress commits", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return await response.json() as any;
  };
  try {
    const bot = (await api("/api/bots", { name: "Delivery restart probe" })).bot;
    const created = await api("/api/webhooks", { name: "Only once", prompt: "Handle this event once", botId: bot.id });
    await waitForExit(fixture.child, { signal: "SIGTERM" });

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
    // This disposable child executes the real enqueue then exits before the
    // WebhookManager can record acceptance. No production crash switch needed.
    const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { RoutineManager } from ${JSON.stringify(new URL("./routines.ts", import.meta.url).href)};
      import { WebhookManager } from ${JSON.stringify(new URL("./webhooks.ts", import.meta.url).href)};
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const routines = new RoutineManager({ botState: () => 'busy', createTask: () => null, startTurn: async () => {} });
      const hooks = new WebhookManager({ botState: () => 'busy', enqueue: event => {
        routines.enqueueWebhook(event);
        process.exit(86);
      }});
      hooks.receive(input.endpointId, input.secret, { deliveryId: 'restart-event', payload: { item: 1 } });
    `], {
      env, timeout: 10_000, encoding: "utf8",
      input: JSON.stringify({ endpointId: created.webhook.endpointId, secret: created.credential.secret }),
    });
    expect(crash.status, crash.stderr).toBe(86);
    const committed = JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8")).runs[0] as RoutineRun;
    expect(JSON.parse(readFileSync(join(dataDir, "webhooks.json"), "utf8")).deliveries).toEqual([]);
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      const runs: RoutineRun[] = (await api("/api/routines")).runs;
      return runs.find((run) => run.id === committed.id)?.status;
    }, { timeout: 20_000, interval: 150 }).toBe("completed");

    const response = await fetch(created.credential.url, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-event" },
      body: JSON.stringify({ item: 1 }), signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ duplicate: true, runId: committed.id });
    const runs: RoutineRun[] = (await api("/api/routines")).runs;
    expect(runs.filter((run) => run.webhookId === created.webhook.id)).toHaveLength(1);
    const run = runs.find((run) => run.id === committed.id)!;
    const wait = await runControlOmb(["wait", "--bot", bot.id, "--task", run.threadId!, "--url", url]);
    const messages = await runControlOmb(["messages", "--bot", bot.id, "--task", run.threadId!, "--url", url]);
    expect(wait).toMatchObject({ status: "settled" });
    const evidencePath = `${logPath}.webhook-restart.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, crashExit: crash.status, receipt, runs, wait, messages }, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath }));
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 45_000);
