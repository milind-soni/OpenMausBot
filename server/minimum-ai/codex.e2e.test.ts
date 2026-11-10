import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { startFakeConnectedApps } from "../testing/fake-connected-apps.ts";

it("builds and replays a workflow with a Codex bot without calling its model again", async () => {
  const apps = await startFakeConnectedApps();
  apps.workflowSchemas = true;
  const scratch = mkdtempSync(join(tmpdir(), "omb-workflow-codex-"));
  const log = join(scratch, "codex.jsonl");
  const plan = { version: 1, steps: [{ kind: "call", id: "inbox", tool: "GMAIL_FETCH_EMAILS", input: { user_id: "me", query: "after:0" } }] };
  const fixture = await launchVerificationServer({ ...process.env, OMB_MINIMUM_AI_EXPERIMENT: "1", OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token, FAKE_CODEX_TEXT_REPLY: JSON.stringify(plan), FAKE_CODEX_TEXT_LOG: log }, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  try {
    const codex = (await api("GET", "/api/instances")).instances.find((instance: { instanceId: string }) => instance.instanceId === "codex");
    const bot = (await api("POST", "/api/bots", { name: "Codex workflow", modelSelection: { instanceId: "codex", model: codex.models.default } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorScopes: { apps: { gmail: "read" } } });
    const routine = (await api("POST", "/api/routines", { name: "Inbox", prompt: "Read the sample inbox", botId: bot.id, target: "bot", runOn: "maus", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false })).routine;
    const base = `/api/routines/${routine.id}/minimum-ai`;
    const draft = (await api("POST", `${base}/prepare`, {})).workflow;
    expect(draft.plan).toEqual(plan);
    expect((await api("POST", `${base}/test`, { fingerprint: draft.fingerprint })).result.status).toBe("completed");
    await api("POST", `${base}/approve`, { fingerprint: draft.fingerprint });
    const calls = () => readFileSync(log, "utf8").trim().split("\n").length;
    expect(calls()).toBe(1);
    const run = (await api("POST", `/api/routines/${routine.id}/run`, {})).run;
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((entry: { id: string }) => entry.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
    expect(calls()).toBe(1);
  } finally { await fixture.close(); await apps.close(); rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);
