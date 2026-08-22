// Notification policy has pure unit coverage; this pins the production wiring
// from a real failed routine turn through RoutineManager and the server's SSE
// stream. A generic `done` frame for the same failure would produce two desktop
// notifications, so the marker PATCH below is an ordering barrier before the
// exact emitted set is asserted.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

interface BotPatchBody {
  name?: string;
  notifications?: boolean;
  modelSelection?: { instanceId: string; model: string };
}

interface RoutineBody {
  name: string;
  prompt: string;
  botId: string;
  runOn: "maus";
  schedule: { type: "once"; at: number };
}

const api = async (
  method: string,
  path: string,
  body?: BotPatchBody | RoutineBody,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

posixOnly("routine failure notification wiring", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-notifications-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            // fail-after-text streams a partial answer before failing: with a
            // NON-empty reply, only the routine-failed/done dedup suppresses
            // the generic done — exit-early would pass on the empty-reply
            // rule alone and leave the dedup guard untested.
            environment: { FAKE_ACP_MODE: "fail-after-text" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "emits one routine-failed notification for the detached task and no generic done notification",
    async () => {
      const listed = await api("GET", "/api/bots");
      const bot = listed.body.bots[0];
      expect(
        (
          await api("PATCH", `/api/bots/${bot.id}`, {
            name: "Routine Scout",
            notifications: true,
            modelSelection: { instanceId: "grok", model: "fake-model" },
          })
        ).status,
      ).toBe(200);

      const created = await api("POST", "/api/routines", {
        name: "Broken nightly report",
        prompt: "Prepare the report",
        botId: bot.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
      });
      expect(created.status).toBe(201);

      const stream = await openSse(`${BASE}/api/events`);
      try {
        await stream.until((frame) => frame.kind === "hello");
        const launched = await api("POST", `/api/routines/${created.body.routine.id}/run`);
        expect(launched.status).toBe(201);

        const frame = await stream.until(
          (candidate) =>
            candidate.kind === "notify" &&
            candidate.notification?.kind === "routine-failed" &&
            candidate.notification?.botId === bot.id,
          30_000,
        );
        expect(frame.notification).toMatchObject({
          kind: "routine-failed",
          botId: bot.id,
          title: "Routine Scout's routine failed",
        });
        expect(frame.notification.threadId).not.toBe(bot.threadId);
        expect(frame.notification.body).toContain("Broken nightly report");

        const receipts = await api("GET", "/api/routines");
        const receipt = receipts.body.runs.find((run: { id: string }) => run.id === launched.body.run.id);
        expect(receipt).toMatchObject({
          status: "failed",
          botId: bot.id,
          threadId: frame.notification.threadId,
        });

        // A unique bot patch is an SSE ordering barrier: by the time it is
        // observed, every notification emitted by the failed turn is already
        // in `frames`, including an accidental generic `done` duplicate.
        expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Failure observed" })).status).toBe(200);
        await stream.until(
          (candidate) => candidate.kind === "bot" && candidate.bot?.id === bot.id && candidate.bot?.name === "Failure observed",
        );

        expect(
          stream.frames
            .filter(
              (candidate) =>
                candidate.kind === "notify" && candidate.notification?.threadId === frame.notification.threadId,
            )
            .map((candidate) => candidate.notification.kind),
        ).toEqual(["routine-failed"]);
      } finally {
        stream.close();
        await api("DELETE", `/api/routines/${created.body.routine.id}`);
      }
    },
    60_000,
  );
});
