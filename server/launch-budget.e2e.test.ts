// The launch budget at turn admission, end to end (Phase 0, item 0.4). The
// budget governs UNATTENDED launches only, so the scenario uses routines
// run on demand: with the concurrency cap at 1, a second routine's run
// stays queued while the first bot's run is held open, the snapshot shows
// one active launch, and the second run starts and completes once the first
// settles. A person's own message is never held by the budget. Admission
// runs before any driver, so this is the same for every engine; the ACP fake
// is used because its gate makes a deterministic busy window.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Run { id: string; botId: string; status: string; routineId: string }

posixOnly("launch budget e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const gate = () => join(home, "acp.gate");
  const started = () => join(home, "acp.started");

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const runsOf = async (routineId: string): Promise<Run[]> =>
    ((await api("GET", "/api/routines")).body.runs as Run[]).filter((r) => r.routineId === routineId);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const routineFor = async (botId: string, name: string) => {
    const created = await api("POST", "/api/routines", {
      name,
      prompt: `do the ${name} job`,
      target: "bot",
      botId,
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "10:00", weekdays: [1, 2, 3, 4, 5] },
    });
    expect(created.status).toBe(201);
    return created.body.routine.id as string;
  };

  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-launch-budget-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      launches: { maxConcurrent: 1, maxPerHour: 120, maxPerDay: 800 },
      instances: {
        gated: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate(), FAKE_ACP_STARTED_FILE: started() },
          config: { cli: FAKE_ACP, fullAuto: true },
        },
        plain: { driver: "grokAgent", config: { cli: FAKE_ACP, fullAuto: true } },
      },
    }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("holds a second unattended launch in the queue while the cap is full, and runs it once the first settles", async () => {
    const a = (await api("POST", "/api/bots")).body.bot;
    const b = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${a.id}`, { modelSelection: { instanceId: "gated", model: "fake-model" } })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${b.id}`, { modelSelection: { instanceId: "plain", model: "fake-model" } })).status).toBe(200);
    const first = await routineFor(a.id, "first");
    const second = await routineFor(b.id, "second");

    expect((await api("POST", `/api/routines/${first}/run`)).status).toBe(201);
    await waitFor(async () => existsSync(started()), "the first run to reach its engine");
    expect((await api("GET", "/api/launch-budget")).body).toMatchObject({ active: 1, limits: { maxConcurrent: 1 } });

    expect((await api("POST", `/api/routines/${second}/run`)).status).toBe(201);
    // the budget refuses the second launch; the routine parks instead of failing
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await runsOf(second)).map((r) => r.status)).toEqual(["queued"]);
    expect((await runsOf(first)).map((r) => r.status)).toEqual(["running"]);

    // a person's own message is never held by the budget
    expect((await api("POST", `/api/bots/${b.id}/messages`, { text: "hello while the cap is full" })).status).toBe(202);
    await waitFor(async () => {
      const bot = await getBot(b.id);
      return !bot.busy && bot.messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.text);
    }, "the person's turn to complete regardless of the cap");

    writeFileSync(gate(), "go");
    await waitFor(async () => (await runsOf(first)).every((r) => r.status === "completed"), "the first run to complete");
    await waitFor(async () => (await runsOf(second)).every((r) => r.status === "completed"), "the parked run to start and complete");
    expect((await api("GET", "/api/launch-budget")).body.active).toBe(0);
  }, 90_000);
});
