import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

it("preserves peer approval outcomes through real HTTP responses and sends no work without an allow", async () => {
  const fixture = await launchVerificationServer(process.env);
  const { url, dataDir, logPath } = fixture.info;
  const gate = join(dataDir, "finish-provider");
  const evidence: unknown[] = [];
  let child: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, token?: string, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (expectedStatus !== undefined) expect(response.status).toBe(expectedStatus);
    else expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result as any;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const card = async (threadId: string) => {
    let found: any;
    await expect.poll(async () => {
      found = (await messages(threadId)).find(m => m.card?.requestId && !m.card.answered && !m.card.dismissed);
      return Boolean(found);
    }, { timeout: 15_000 }).toBe(true);
    return found;
  };
  try {
    expect((await cli("doctor")).ok).toBe(true);
    const from = (await cli("new-bot", "--name", "Approval source")).bot;
    const target = (await cli("new-bot", "--name", "Approval target")).bot;
    target.threadId = target.activeTaskId;
    // Peer review applies below Full access.
    await api("PATCH", `/api/bots/${from.id}`, { approvePeerComms: true, approvalMode: "ask" });
    // Reuse the shared launcher's disposable data with a provider turn that stays open.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({ ...process.env, FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, dataDir, Number(new URL(url).port));
    const log = openSync(logPath, "a", 0o600);
    child = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // A routine turn drives the first half; the second half uses coordinate_bots from chat.
    const created = await api("POST", "/api/routines", {
      name: "Peer approval fixture", prompt: "Hold this fixture turn while approval is tested.",
      botId: from.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const started = await api("POST", `/api/routines/${created.routine.id}/run`);
    await expect.poll(async () => {
      const run = (await api("GET", "/api/routines")).runs.find((r: any) => r.id === started.run.id);
      from.threadId = run?.threadId;
      return Boolean(from.threadId);
    }, { timeout: 15_000 }).toBe(true);
    let token = "";
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; }
      catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    const handoffs = () => readHandoffs(dataDir);
    {
      const pending = api("POST", "/api/internal/coordinate-bots", { botIds: [target.id], message: "Do not dispatch without approval", consult: true }, token, 403);
      void pending.catch(() => {}); // retain the rejection for the awaited assertion below
      const approval = await card(from.threadId);
      expect(approval.card.tool).toBe("ask_bot");
      await api("POST", `/api/threads/${from.threadId}/respond`, { requestId: approval.card.requestId, behavior: "deny" });
      const result = await pending;
      expect(result.approvals).toEqual([{ botId: target.id, error: "denied by user", approvalOutcome: "deny", approvalSource: "user" }]);
      expect(result.error).toBe("Denied by user; no work sent.");
      expect(result.receipts).toBeUndefined();
      const settled = (await messages(from.threadId)).find(m => m.id === approval.id);
      expect(settled.card).toMatchObject({ answered: "deny", dismissed: false });
      expect(handoffs().filter((node) => node.parentId)).toEqual([]);
      evidence.push({ operation: "coordinate-bots consult", outcome: "deny", result, card: settled.card });
    }
    const unavailableAsk = api("POST", "/api/internal/coordinate-bots", { botIds: [target.id], message: "Check access again after approval", consult: true }, token, 409);
    void unavailableAsk.catch(() => {});
    const unavailableCard = await card(from.threadId);
    await api("PATCH", `/api/bots/${target.id}`, { hidden: true, name: "Private renamed teammate" });
    await api("POST", `/api/threads/${from.threadId}/respond`, { requestId: unavailableCard.card.requestId, behavior: "allow" });
    const unavailableResult = await unavailableAsk;
    expect(unavailableResult.receipts).toHaveLength(1);
    expect(unavailableResult.receipts[0]).toMatchObject({ botId: target.id, outcome: "failed" });
    expect(unavailableResult.receipts[0]).not.toHaveProperty("requestId");
    expect(JSON.stringify(unavailableResult)).not.toContain("Private renamed teammate");
    expect((await messages(target.threadId)).some(m => m.role === "user")).toBe(false);
    expect(handoffs().filter((node) => node.parentId)).toEqual([]);
    evidence.push({ operation: "consult-after-visibility-revocation", result: unavailableResult, targetDispatched: false });
    await api("PATCH", `/api/bots/${target.id}`, { hidden: false, name: target.name });

    const pendingDelegation = api("POST", "/api/internal/coordinate-bots", { botIds: [target.id], message: "Fixture delegation awaiting approval" }, token, 403);
    void pendingDelegation.catch(() => {});
    const approval = await card(from.threadId);
    expect(approval.card.tool).toBe("delegate_bot");
    await api("POST", `/api/threads/${from.threadId}/respond`, { requestId: approval.card.requestId, behavior: "deny" });
    const denied = await pendingDelegation;
    expect(denied.approvals).toEqual([{ botId: target.id, error: "denied by user", approvalOutcome: "deny", approvalSource: "user" }]);
    expect(denied.error).toBe("Denied by user; no work sent.");
    expect((await messages(target.threadId)).some(m => m.role === "user")).toBe(false);
    expect((await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === target.id).busy).toBe(false);
    expect(handoffs().filter((node) => node.parentId)).toEqual([]);
    evidence.push({ operation: "coordinate-bots", result: denied, targetDispatched: false });
    writeFileSync(gate, "finish");
    expect((await cli("wait", "--bot", from.id, "--task", from.threadId, "--timeout", "25")).status).toBe("settled");

    rmSync(gate, { force: true });
    rmSync(fixture.fixtureDumpPath, { force: true });
    const other = (await cli("new-bot", "--name", "Second approval target")).bot;
    await cli("send", "--bot", from.id, "--task", from.threadId, "--text", "Check the completed handoff and request two teammates.");
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; }
      catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    const outstanding = await api("GET", "/api/internal/assignment-status", undefined, token);
    expect(outstanding).toEqual({ outstanding: [] });
    const pendingBatch = api("POST", "/api/internal/coordinate-bots", {
      botIds: [target.id, other.id], message: "Neither teammate should start", requestKey: "approval-fixture-batch",
    }, token, 403);
    void pendingBatch.catch(() => {});
    let cards: any[] = [];
    await expect.poll(async () => {
      cards = (await messages(from.threadId)).filter(m => m.card?.requestId && !m.card.answered && !m.card.dismissed);
      return cards.length;
    }, { timeout: 15_000 }).toBe(2);
    const first = cards.find(m => m.card.title.endsWith(`@${target.name}`));
    expect(first).toBeDefined();
    await api("POST", `/api/threads/${from.threadId}/respond`, { requestId: first.card.requestId, behavior: "deny" });
    const second = cards.find(m => m.card.title.endsWith(`@${other.name}`));
    expect(second).toBeDefined();
    await api("POST", `/api/threads/${from.threadId}/respond`, { requestId: second.card.requestId, behavior: "allow" });
    const batch = await pendingBatch;
    expect(batch.approvals).toEqual([
      { botId: target.id, error: "denied by user", approvalOutcome: "deny", approvalSource: "user" },
    ]);
    expect(batch.error).toContain("no work sent");
    expect((await messages(target.threadId)).some(m => m.role === "user")).toBe(false);
    expect((await messages(other.activeTaskId)).some(m => m.role === "user")).toBe(false);
    expect(handoffs().filter((node) => node.parentId)).toEqual([]);
    evidence.push({ operation: "assignment-status", outstanding }, { operation: "coordinate-bots", result: batch });
    writeFileSync(gate, "finish");
    expect((await cli("wait", "--bot", from.id, "--task", from.threadId, "--timeout", "25")).status).toBe("settled");
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    const evidencePath = `${logPath}.peer-approval.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence }, null, 2));
    console.info(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}, 100_000);
