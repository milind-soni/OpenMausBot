import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("confirms alert and voice proposals, expires stale cards, and supersedes credential requests in an isolated conversation", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-profile-cards-"));
  const gate = join(gates, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Profile fixture" }, 201)).bot;
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Review my profile preferences.");
    let token = "";
    await expect.poll(() => {
      try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; }
      catch { return false; }
      return Boolean(token);
    }, { timeout: 15_000 }).toBe(true);
    const propose = (changes: unknown) => api("POST", "/api/internal/profile-requests", {
      fromBotId: bot.id, fromThreadId: bot.threadId, changes, reason: "Requested fixture preferences",
    }, 201, token);
    const stale: Array<{ requestId: string }> = [];
    for (let index = 0; index < 8; index++) stale.push(await propose({ title: `Stale title ${index}` }));
    await api("PATCH", `/api/bots/${bot.id}`, { description: "Changed after review was prepared" });
    writeFileSync(gate, "finish");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy,
      { timeout: 15_000 }).toBe(false);
    const respond = (requestId: string, expected = 200) => api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, expected);
    for (const proposal of stale) await respond(proposal.requestId, 409);
    await respond(stale[0]!.requestId, 409);
    // Terminal cards must not block waits or permanently consume the eight-card quota.
    expect((await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20")).status).toBe("settled");
    const previousPid = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid;
    unlinkSync(gate);
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Propose fresh preferences after the old cards expired.");
    await expect.poll(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid,
      { timeout: 15_000 }).not.toBe(previousPid);
    token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const toggle = await propose({ notifications: false, speakReplies: true });
    const credential = (reason: string) => api("POST", "/api/internal/request-credential", {
      fromBotId: bot.id, fromThreadId: bot.threadId, credentialId: "openaiImageApiKey", reason,
    }, 201, token);
    const prior = await credential("First request");
    const fresh = await credential("Replacement request");
    expect(fresh.messageId).not.toBe(prior.messageId);
    writeFileSync(gate, "finish");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy,
      { timeout: 15_000 }).toBe(false);
    await respond(toggle.requestId);
    const changed = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(changed).toMatchObject({ notifications: false, speakReplies: true, title: "" });
    const transcript = await api("GET", `/api/threads/${bot.threadId}/messages`);
    expect(transcript.messages.find((message: any) => message.card?.requestId === stale[0]!.requestId)?.card)
      .toMatchObject({ expired: true, options: [] });
    expect(transcript.messages.find((message: any) => message.id === prior.messageId)?.secret)
      .toMatchObject({ superseded: true });
    for (const action of ["provided", "resume", "dismiss"]) {
      const rejected = await api("POST", `/api/bots/${bot.id}/secret-cards/${prior.messageId}/${action}`, { threadId: bot.threadId }, 409);
      expect(rejected.error).toContain("superseded");
    }
    await api("POST", `/api/bots/${bot.id}/secret-cards/${fresh.messageId}/dismiss`, { threadId: bot.threadId });
    expect((await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20")).status).toBe("settled");
    await control("messages", "--bot", bot.id, "--task", bot.threadId, "--limit", "30");
  } finally {
    const evidencePath = `${fixture.info.logPath}.profile-cards.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close();
    await removeTempDir(gates);
  }
}, 60_000);
