import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { ROUTINE_SUPERSEDED } from "./routine-execution.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

let fixture: VerificationServer | undefined;
let restarted: ChildProcess | undefined;
afterEach(async () => {
  await waitForExit(restarted, { signal: "SIGTERM" });
  await fixture?.close();
});

it("starts the next scheduled run of a routine whose sign-in nobody answered, and stops the old wait", async () => {
  fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const raw = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const { status, body: value } = await raw(method, path, body);
    expect(status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const runs = async () => (await api("GET", "/api/routines")).runs as any[];
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const bot = (await runControlOmb(["new-bot", "--name", "Morning bot", "--url", url]) as any).bot;
  // Each conversation's turn waits on its own gate file, so a run stays running until the test finishes it.
  const wrapper = join(dataDir, "routine-gated.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const at = process.argv.indexOf("--mcp-config");',
    'const thread = at < 0 ? "probe" : JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers?.agents?.env?.OMB_THREAD_ID ?? "probe";',
    'process.env.FAKE_CLAUDE_MODE = thread === "probe" ? "happy" : "slow";',
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(dataDir)}, thread + ".gate");`,
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(dataDir)}, thread + ".json");`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  await api("PATCH", "/api/config", { features: { browser: true } });
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser" });
  const { routine } = await api("POST", "/api/routines", {
    name: "Morning check", prompt: "Sign in to the site and check the dashboard.", botId: bot.id,
    schedule: { type: "cron", expression: "30 7 * * 1-5", timeZone: "Europe/London" },
  });

  const { run: first } = await api("POST", `/api/routines/${routine.id}/run`);
  await expect.poll(async () => (await runs()).find((run) => run.id === first.id)?.status, { timeout: 15_000 }).toBe("running");
  const threadId = (await runs()).find((run) => run.id === first.id).threadId as string;
  let launch: any;
  await expect.poll(() => {
    try { launch = JSON.parse(readFileSync(join(dataDir, `${threadId}.json`), "utf8")); return true; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  const asked = await raw("POST", "/api/internal/request-sign-in", { site: "example.com" }, launch.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN);
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  writeFileSync(join(dataDir, `${threadId}.gate`), "finish");
  await expect.poll(async () => (await runs()).find((run) => run.id === first.id)?.status, { timeout: 15_000 }).toBe("waiting");
  expect((await runs()).find((run) => run.id === first.id).waitingSince).toEqual(expect.any(Number));
  expect(readHandoffs(dataDir).find((node) => node.threadId === threadId)).toMatchObject({ status: "waiting", cards: [asked.body.messageId] });

  // A day later, with nobody having answered: the stopped server's own store says so, then it starts again.
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const file = join(dataDir, "routines.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  const dueAt = Date.now() - 1_000;
  disk.routines[0].nextRunAt = dueAt;
  disk.runs.find((run: any) => run.id === first.id).waitingSince = dueAt - 24 * 60 * 60_000;
  writeFileSync(file, JSON.stringify(disk));
  const log = openSync(logPath, "a", 0o600);
  restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
  });
  closeSync(log);

  await expect.poll(async () => {
    try { return (await runs()).find((run) => run.id === first.id)?.status; } catch { return "starting"; }
  }, { timeout: 20_000 }).toBe("cancelled");
  const old = (await runs()).find((run) => run.id === first.id);
  expect(old).toMatchObject({ error: ROUTINE_SUPERSEDED });
  await expect.poll(async () => (await runs()).find((run) => run.id !== first.id)?.status, { timeout: 15_000 }).toBe("running");
  const next = (await runs()).find((run) => run.id !== first.id);
  expect(next).toMatchObject({ routineId: routine.id, triggerSource: "schedule", scheduledFor: dueAt });
  expect(next.threadId).not.toBe(threadId);
  const saved = (await api("GET", "/api/routines")).routines[0];
  expect(saved.skippedRuns).toBeUndefined();
  expect(saved.nextRunAt).toBeGreaterThan(Date.now());

  // The old conversation's question is closed, and answering it now resumes nothing.
  expect(readHandoffs(dataDir).find((node) => node.threadId === threadId)?.status).toBe("cancelled");
  expect((await messages(threadId)).find((message) => message.kind === "signin")?.signIn).toMatchObject({ stopped: true });
  const late = await raw("POST", `/api/bots/${bot.id}/sign-in-cards/${asked.body.messageId}/done`, { threadId });
  expect(late.body).toMatchObject({ resumed: false });
  // Where the routine reports, the line that named the sign-in no longer says it needs the person.
  const named = (await messages(old.resultsThreadId)).find((message) => message.automation?.runId === first.id);
  expect(named).toMatchObject({ kind: "text", text: "I need you to sign in to example.com.", automation: { copyOf: asked.body.messageId } });
  await expect.poll(async () => (await messages(old.resultsThreadId)).find((message) => message.id === named.id)?.automation?.needsYou, { timeout: 15_000 })
    .toBeUndefined();

  writeFileSync(join(dataDir, `${next.threadId}.gate`), "finish");
  await expect.poll(async () => (await runs()).find((run) => run.id === next.id)?.status, { timeout: 15_000 }).toBe("completed");
}, 90_000);
