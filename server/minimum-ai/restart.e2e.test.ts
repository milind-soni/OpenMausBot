import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { startFakeConnectedApps } from "../testing/fake-connected-apps.ts";
import { waitForExit } from "../testing/cleanup.ts";

it("does not replay an in-flight action after a server crash", async () => {
  const apps = await startFakeConnectedApps(); apps.workflowSchemas = true;
  const plan = { version: 1, steps: [{ kind: "call", id: "inbox", tool: "GMAIL_FETCH_EMAILS", input: { user_id: "me", query: "after:0" } }] };
  const env = { ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1", OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token, FAKE_CLAUDE_TEXT_RESULT: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(plan) }) };
  const fixture = await launchVerificationServer(env);
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Crash fixture" })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorScopes: { apps: { gmail: "read" } } });
    const routine = (await api("POST", "/api/routines", { name: "Read inbox", prompt: "Read my inbox", botId: bot.id, schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    const draft = (await api("POST", `${base}/prepare`, {})).workflow;
    await api("POST", `${base}/test`, { fingerprint: draft.fingerprint });
    await api("POST", `${base}/approve`, { fingerprint: draft.fingerprint });
    apps.workflowDelayMs = 8_000;
    const run = (await api("POST", `/api/routines/${routine.id}/run`, {})).run;
    await expect.poll(() => apps.calls.filter((call) => call.tool === "GMAIL_FETCH_EMAILS").length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => { try { return JSON.parse(readFileSync(join(fixture.info.dataDir, "routines.json"), "utf8")).runs.some((item: { id: string; status: string }) => item.id === run.id && item.status === "running"); } catch { return false; } }, { timeout: 10_000 }).toBe(true);
    await waitForExit(fixture.child, { signal: "SIGKILL" });
    apps.workflowDelayMs = 0;
    const childEnv = verificationServerEnvironment(env, fixture.info.dataDir, Number(new URL(fixture.info.url).port));
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(childEnv), { cwd: process.cwd(), env: childEnv, stdio: ["ignore", log, log] }); closeSync(log);
    await expect.poll(async () => { try { return (await fetch(`${fixture.info.url}/api/health`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    expect((await api("GET", "/api/routines")).runs.find((item: { id: string }) => item.id === run.id)).toMatchObject({ status: "failed" });
    expect((await api("GET", base)).interrupted).toBe(true);
    const blocked = (await api("POST", `/api/routines/${routine.id}/run`, {})).run;
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: { id: string }) => item.id === blocked.id)?.status, { timeout: 10_000 }).toBe("failed");
    expect(apps.calls.filter((call) => call.tool === "GMAIL_FETCH_EMAILS")).toHaveLength(2);
    await api("POST", `${base}/acknowledge`, { confirm: true });
    const next = (await api("POST", `/api/routines/${routine.id}/run`, {})).run;
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: { id: string }) => item.id === next.id)?.status, { timeout: 10_000 }).toBe("completed");
    expect(apps.calls.filter((call) => call.tool === "GMAIL_FETCH_EMAILS")).toHaveLength(3);
  } finally { await waitForExit(restarted, { signal: "SIGTERM" }); await fixture.close(); await apps.close(); }
}, 120_000);
