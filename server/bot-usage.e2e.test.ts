import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { createHarnessClient } from "./drivers/agents-client.ts";
import { callUsageLimitsTool } from "./drivers/agents-usage-tool.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { appendUsage } from "./usage-ledger.ts";

it("reads actual headroom through an active turn's capability, even once the cap is reached", async () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-bot-usage-e2e-"));
  const gate = join(folder, "finish");
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    const { info: { url, dataDir }, fixtureDumpPath } = fixture;
    const request = (path: string, init: RequestInit = {}) => fetch(url + path, { ...init, headers: { "content-type": "application/json", origin: url, ...init.headers } });
    const create = async (name: string) => {
      const response = await request("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
      expect(response.status).toBe(201);
      return (await response.json() as { bot: { id: string; threadId: string } }).bot;
    };
    const scout = await create("Scout");
    const peer = await create("Peer");
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    for (const at of [now, nextMonth]) for (const bot of [scout, peer]) {
      expect(await appendUsage(dataDir, {
        at: at.toISOString(), botId: bot.id, botName: "Fixture", threadId: bot.threadId, instanceId: "test-account",
        driverKind: "claude", model: "fixture", input: bot === scout ? 10 : 30, output: 2, costUsd: 0.01, trigger: { kind: "owner" },
      })).toBe(true);
    }
    const setCap = async (monthlyTokens: number) => {
      const response = await request("/api/usage/caps", { method: "PUT", body: JSON.stringify({ bots: { [scout.id]: { monthlyTokens } } }) });
      expect(response.status).toBe(200);
    };
    await setCap(24);
    await runControlOmb(["send", "--bot", scout.id, "--task", scout.threadId, "--text", "Check usage before handing off work", "--url", url]);
    let token = "";
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; }
      return Boolean(token);
    }, { timeout: hostTimeout(15_000) }).toBe(true);
    const client = createHarnessClient(url, token);
    const botUsagePath = "/api/internal/engine-limits?scope=bot";
    expect((await createHarnessClient(url, "wrong").apiResponse(botUsagePath)).status).toBe(401);
    expect((await client.apiResponse(`${botUsagePath}&botId=${peer.id}`)).status).toBe(403);
    const subscription = await callUsageLimitsTool({ client });
    expect(subscription.isError).toBeUndefined();
    expect(JSON.parse(subscription.text)).toEqual({ accounts: expect.any(Array) });
    const before = await callUsageLimitsTool({ client }, { scope: "bot", period: "month", thread: "this" });
    expect(before.isError).toBeUndefined();
    expect(JSON.parse(before.text)).toMatchObject({
      totals: { turns: 1, input: 10, output: 2 },
      caps: [{ used: 12, remaining: 12, reached: false }],
    });

    await setCap(12);
    const reached = await callUsageLimitsTool({ client }, { scope: "bot", period: "month" });
    expect(JSON.parse(reached.text)).toMatchObject({ caps: [{ used: 12, remaining: 0, reached: true, resetsAt: expect.any(Number) }] });
    writeFileSync(gate, "finish");
    await runControlOmb(["wait", "--bot", scout.id, "--task", scout.threadId, "--timeout", "30", "--url", url]);
    expect((await client.apiResponse(botUsagePath)).status).toBe(401);
  } finally {
    try { await fixture?.close(); } finally { await removeTempDir(folder); }
  }
}, hostTimeout(60_000));
