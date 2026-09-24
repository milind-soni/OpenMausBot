import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("preserves peer approval expiry through real HTTP responses and durable delegation receipts", async () => {
  const fixture = await launchVerificationServer(process.env);
  const { url, dataDir, logPath } = fixture.info;
  const gate = join(dataDir, "finish-provider");
  const expiry = join(dataDir, "expire-peer-approval");
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
    await api("PATCH", `/api/bots/${from.id}`, { approvePeerComms: true });
    // Reuse the shared launcher's disposable data and restricted environment.
    // The import hook controls only the peer timer, not approval or dispatch.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({ ...process.env, FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, dataDir, Number(new URL(url).port));
    env.OMB_TEST_PEER_APPROVAL = "1";
    const log = openSync(logPath, "a", 0o600);
    child = spawn(process.execPath, ["--import", new URL("./testing/peer-approval-hooks.mjs", import.meta.url).href,
      fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // Routines retain the one-hop ask/delegate lifecycle. Ordinary chat uses
    // coordinate_bots instead; do not bypass that production routing boundary.
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
    for (const outcome of ["deny", "expired"] as const) {
      const pending = api("POST", "/api/internal/ask-bot", { toBotId: target.id, message: "Do not dispatch without approval" }, token);
      void pending.catch(() => {}); // retain the rejection for the awaited assertion below
      const approval = await card(from.threadId);
      if (outcome === "deny") await api("POST", `/api/threads/${from.threadId}/respond`, { requestId: approval.card.requestId, behavior: "deny" });
      else writeFileSync(expiry, "expire");
      const result = await pending;
      expect(result).toMatchObject({ approvalOutcome: outcome, approvalSource: outcome === "deny" ? "user" : "system" });
      expect(result.error).toBe(outcome === "deny" ? "denied by user" : "the approval card expired without an answer");
      const settled = (await messages(from.threadId)).find(m => m.id === approval.id);
      expect(settled.card).toMatchObject({ answered: "deny", dismissed: outcome !== "deny" });
      evidence.push({ operation: "ask-bot", outcome, result, card: settled.card });
      rmSync(expiry, { force: true });
    }
    const queued = await api("POST", "/api/internal/delegate-bot", { toBotId: target.id, message: "Fixture delegation awaiting approval" }, token);
    writeFileSync(gate, "finish");
    const approval = await card(from.threadId);
    writeFileSync(expiry, "expire");
    let receipt: any;
    await expect.poll(() => {
      const path = join(dataDir, "delegation-receipts.json");
      if (!existsSync(path)) return false;
      receipt = JSON.parse(readFileSync(path, "utf8")).find((r: any) => r.id === queued.taskId);
      return Boolean(receipt);
    }, { timeout: 15_000 }).toBe(true);
    expect(receipt).toMatchObject({ status: "expired", approvalOutcome: "expired", approvalSource: "system",
      result: "the approval card expired without an answer" });
    expect((await messages(from.threadId)).find(m => m.id === approval.id).card.dismissed).toBe(true);
    expect((await messages(target.threadId)).some(m => m.role === "user")).toBe(false);
    expect((await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === target.id).busy).toBe(false);
    evidence.push({ operation: "delegate-bot", receipt, targetDispatched: false });
    expect((await cli("wait", "--bot", from.id, "--task", from.threadId, "--timeout", "25")).status).toBe("settled");

    // Ordinary chat's multi-target gate must retain each refusal's origin,
    // rather than saying that every target was denied by the user.
    rmSync(expiry, { force: true });
    rmSync(gate, { force: true });
    rmSync(fixture.fixtureDumpPath, { force: true });
    const other = (await cli("new-bot", "--name", "Second approval target")).bot;
    await cli("send", "--bot", from.id, "--task", from.threadId, "--text", "Check the completed handoff and request two teammates.");
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; }
      catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    const readback = await api("GET", `/api/internal/delegations/${queued.taskId}?fromBotId=${from.id}&fromThreadId=${from.threadId}`, undefined, token);
    expect(readback).toMatchObject({ status: "expired", approvalOutcome: "expired", approvalSource: "system" });
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
    writeFileSync(expiry, "expire");
    const batch = await pendingBatch;
    expect(batch.approvals).toEqual([
      { botId: target.id, error: "denied by user", approvalOutcome: "deny", approvalSource: "user" },
      { botId: other.id, error: "the approval card expired without an answer", approvalOutcome: "expired", approvalSource: "system" },
    ]);
    expect(batch.error).toContain("no work sent");
    expect((await messages(target.threadId)).some(m => m.role === "user")).toBe(false);
    expect((await messages(other.activeTaskId)).some(m => m.role === "user")).toBe(false);
    evidence.push({ operation: "check-delegation", readback }, { operation: "coordinate-bots", result: batch });
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
