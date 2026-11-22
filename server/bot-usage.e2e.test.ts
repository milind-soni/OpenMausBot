import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { createHarnessClient } from "./drivers/agents-client.ts";
import { callUsageLimitsTool } from "./drivers/agents-usage-tool.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { appendUsage } from "./usage-ledger.ts";

it("shows exact headroom to a solo turn and keeps restricted usage out of a chat-only device's turn", async () => {
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
    const botUsagePath = "/api/internal/engine-limits?scope=bot";
    const activeClient = async () => {
      let active: ReturnType<typeof createHarnessClient> | undefined;
      await expect.poll(async () => {
        let token: string;
        try { token = JSON.parse(readFileSync(fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; }
        if (!token) return false;
        active = createHarnessClient(url, token);
        return (await active.apiResponse(botUsagePath)).status === 200;
      }, { timeout: hostTimeout(15_000) }).toBe(true);
      return active!;
    };
    const finishTurn = async () => {
      writeFileSync(gate, "finish");
      await runControlOmb(["wait", "--bot", scout.id, "--task", scout.threadId, "--timeout", "30", "--url", url]);
    };
    await runControlOmb(["send", "--bot", scout.id, "--task", scout.threadId, "--text", "Check usage before handing off work", "--url", url]);
    const client = await activeClient();
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
    await finishTurn();
    expect((await client.apiResponse(botUsagePath)).status).toBe(401);
    unlinkSync(gate);

    const room = await request("/api/groups", { method: "POST", body: JSON.stringify({
      name: "Restricted fixture", memberIds: [scout.id, peer.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    }) });
    const roomBody = await room.json() as { group: { id: string; threadId: string }; error?: string };
    expect(room.status, roomBody.error).toBe(201);
    const { group } = roomBody;
    expect((await request(`/api/bots/${peer.id}`, { method: "PATCH", body: JSON.stringify({ visibility: "admins" }) })).status).toBe(200);
    const pairing = await request("/api/auth/pairing", { method: "POST", body: JSON.stringify({ label: "Chat phone", scopes: ["client"] }) });
    expect(pairing.status).toBe(200);
    const { code } = await pairing.json() as { code: string };
    const paired = await request("/api/auth/pair", { method: "POST", body: JSON.stringify({ code }) });
    expect(paired.status).toBe(200);
    const { token: phone } = await paired.json() as { token: string };
    const visible = await request("/api/bots?messages=0", { headers: { authorization: `Bearer ${phone}` } });
    expect(visible.status).toBe(200);
    const phoneView = await visible.text();
    expect(phoneView).toContain(scout.threadId);
    expect(phoneView).not.toContain(group.id);
    await setCap(200_000);
    const sent = await request(`/api/bots/${scout.id}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${phone}` }, body: JSON.stringify({ text: "Check our usage", threadId: scout.threadId }),
    });
    expect(sent.status, await sent.text()).toBe(202);
    const phoneClient = await activeClient();
    const sharedUsage = async () => {
      const result = await callUsageLimitsTool({ client: phoneClient }, { scope: "bot", period: "month" });
      expect(result.isError).toBeUndefined();
      return JSON.parse(result.text);
    };
    const beforePrivateUsage = await sharedUsage();
    expect(beforePrivateUsage).toMatchObject({ totals: { turns: expect.any(Number) }, caps: [], capsComplete: false });
    expect(await appendUsage(dataDir, {
      at: new Date().toISOString(), botId: scout.id, botName: "Scout", threadId: group.threadId, instanceId: "test-account",
      driverKind: "claude", model: "fixture", input: 100_000, output: 2, costUsd: 1, trigger: { kind: "owner" },
    })).toBe(true);
    expect(await sharedUsage()).toEqual(beforePrivateUsage);

    expect((await request(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ memberIds: [scout.id] }) })).status).toBe(200);
    expect(await sharedUsage()).toEqual(beforePrivateUsage);

    await setCap(12);
    expect(await sharedUsage()).toEqual({
      ...beforePrivateUsage, stops: "unattended",
      caps: [{ scope: "bot", period: "month", unit: "tokens", limit: 12, reached: true, resetsAt: nextMonth.getTime() }],
    });
    await finishTurn();
    expect((await phoneClient.apiResponse(botUsagePath)).status).toBe(401);
  } finally {
    try { await fixture?.close(); } finally { await removeTempDir(folder); }
  }
}, hostTimeout(60_000));
