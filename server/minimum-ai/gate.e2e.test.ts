import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { startFakeConnectedApps } from "../testing/fake-connected-apps.ts";
import { createGatedWorkflowConnector } from "./gated-connector.ts";
import { workflowSchemaDigest } from "./binding.ts";
import { createWorkflowStore } from "./store.ts";
import { createRunLedger } from "./ledger.ts";
import { prepareWorkflow, textWorkflowPlanner } from "./planning.ts";
import { runApprovedWorkflow } from "./service.ts";
import { RoutineManager } from "../routines.ts";

it("passes an actual fake bot capability through the app's connector gate", async () => {
  const apps = await startFakeConnectedApps();
  apps.emails.push({ messageId: "m1", threadId: "t1", messageTimestamp: new Date().toISOString(), subject: "Example", sender: "test@example.test", preview: { body: "sample" } });
  const scratch = mkdtempSync(join(tmpdir(), "omb-workflow-gate-"));
  const finish = join(scratch, "finish");
  const fixture = await launchVerificationServer({ ...process.env, OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finish });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`fixture: ${response.status}`);
    return response.json() as Promise<any>;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Test bot" })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorScopes: { apps: { gmail: "read" } } });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Prepare the fixture", sendId: "workflow-gate-test-0001" });
    let bridge: { env: Record<string, string> } | undefined;
    await expect.poll(() => {
      try { bridge = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.composio; } catch { return false; }
      return Boolean(bridge?.env?.OMB_CONNECTOR_UPSTREAM_HEADERS);
    }, { timeout: 20_000 }).toBe(true);
    const endpoint = bridge!.env.OMB_CONNECTOR_UPSTREAM_URL!;
    const bearer = String(JSON.parse(bridge!.env.OMB_CONNECTOR_UPSTREAM_HEADERS!).authorization).replace(/^Bearer /, "");
    const invoke = createGatedWorkflowConnector({ endpoint, bearer, authorize: async () => true });
    const data = await invoke("GMAIL_FETCH_EMAILS", { user_id: "me", query: "after:0" }, new AbortController().signal);
    expect(data).toMatchObject({ messages: [expect.objectContaining({ subject: "Example" })] });
    await expect(invoke("GMAIL_SEND_EMAIL", {}, new AbortController().signal)).rejects.toThrow();
    expect(apps.calls.some((call) => call.tool === "GMAIL_SEND_EMAIL")).toBe(false);
    const plans = createWorkflowStore(join(scratch, "plans.json"));
    const ledger = createRunLedger(join(scratch, "runs.json"));
    const catalog = [{ name: "GMAIL_FETCH_EMAILS", inputSchema: { type: "object" } }];
    const context = { owner: "fixture-owner", botId: bot.id as string, prompt: "Read the inbox", connectionIds: ["fixture-mail"], schemaDigest: workflowSchemaDigest(catalog) };
    const allowed = new Set(["GMAIL_FETCH_EMAILS"]);
    const model = vi.fn(async (_prompt: string) => JSON.stringify({ version: 1, steps: [{ kind: "call", id: "inbox", tool: "GMAIL_FETCH_EMAILS", input: { user_id: "me", query: "after:0" } }] }));
    const proposal = await prepareWorkflow(context.prompt, allowed, textWorkflowPlanner(model));
    const startTurn = vi.fn(async () => {});
    const manager = new RoutineManager({ file: join(scratch, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "fixture-thread" }), startTurn,
      runWorkflow: async (run, signal) => {
        const result = await runApprovedWorkflow({ routineId: run.routineId, runId: run.id, owner: context.owner, context, store: plans, ledger, catalog, allowed, invoke, signal });
        return result.status === "completed" ? { status: "completed" } : { status: "failed", error: result.error ?? "Failed", partial: result.partial };
      } });
    const routine = manager.create({ name: "Read inbox", prompt: context.prompt, botId: bot.id, schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false });
    const draft = plans.saveDraft(routine.id, context.owner, context, proposal.plan, allowed);
    await plans.verify(routine.id, context.owner, context, draft.fingerprint, allowed, invoke);
    plans.approve(routine.id, context.owner, context, draft.fingerprint);
    manager.runNow(routine.id);
    await manager.tick();
    await vi.waitFor(() => expect(manager.listRuns()[0]?.status).toBe("completed"));
    expect(model).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    manager.close();
    writeFileSync(finish, "");
  } finally {
    await fixture.close(); await apps.close(); rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
