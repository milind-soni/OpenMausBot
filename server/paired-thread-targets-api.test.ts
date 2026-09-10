import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("paired thread targets through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let token: string;
  let models: string[];
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    // Pairing credentials belong to this fixture, but never to its evidence.
    evidence.push(path.startsWith("/api/auth/") ? { method, path, status: result.status } : { method, path, body, result });
    return result;
  };
  const paired = (method: string, path: string, body?: unknown) => api(method, path, body, { authorization: `Bearer ${token}` });
  const selection = (model: string) => ({ instanceId: "claude", model });
  const botState = async (id: string) => (await api("GET", "/api/bots?messages=30")).body.bots.find((bot: any) => bot.id === id);
  const page = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).body;
  const idle = (id: string) => expect.poll(async () => (await botState(id)).busy, { timeout: 15_000 }).toBe(false);

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    const invitation = await api("POST", "/api/auth/pairing", { label: "Thread compatibility fixture", scopes: ["client", "admin"] });
    expect(invitation.status).toBe(200);
    const accepted = await api("POST", "/api/auth/pair", { code: invitation.body.code, label: "Old paired client" });
    expect(accepted.status).toBe(200);
    token = accepted.body.token;
    const catalog = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "claude");
    models = catalog.models.options.map((model: any) => model.id);
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.paired-thread-targets.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("refuses ambiguous old-phone actions and keeps explicit A actions on A while B is selected", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Pinned phone", modelSelection: selection(models[0]) })).body.bot;
    const threadA = bot.threadId;
    expect((await paired("POST", `/api/bots/${bot.id}/messages`, { text: "Original A", threadId: threadA })).status).toBe(202);
    await idle(bot.id);
    const beforeA = await page(threadA);
    const userA = beforeA.messages.find((message: any) => message.role === "user" && message.text === "Original A");
    expect(userA).toBeTruthy();
    const threadB = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "B" })).body.task.threadId;
    const beforeB = await page(threadB);
    const actions: Array<[string, string, unknown?]> = [
      ["POST", "/messages", { text: "Must not reach B" }],
      ["POST", "/interrupt"],
      ["POST", "/read"],
      ["POST", "/always-allow", { allowKey: "Bash:ls" }],
      ["POST", `/messages/${userA.id}/edit`, { text: "Must not edit B" }],
      ["POST", "/active-branch", { messageId: userA.id }],
      ["DELETE", "/queue/not-a-queued-message"],
      ["PATCH", "/model", selection(models[1])],
      ["PATCH", "", { modelSelection: selection(models[1]) }],
    ];
    for (const [method, suffix, body] of actions) {
      const result = await paired(method, `/api/bots/${bot.id}${suffix}`, body);
      expect(result.status, `${method} ${suffix}`).toBe(409);
      expect(result.body.error).toMatch(/Update this client.*choose a thread/);
    }
    // The native sidecar's existing marker only narrows local behavior.
    const legacyPhone = await api("POST", `/api/bots/${bot.id}/read`, undefined, { "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "fixture-phone" });
    expect(legacyPhone.status).toBe(409);
    expect((await page(threadA)).messages).toEqual(beforeA.messages);
    expect((await page(threadB)).messages).toEqual(beforeB.messages);
    expect((await botState(bot.id)).modelSelection).toEqual(selection(models[0]));

    expect((await paired("POST", `/api/bots/${bot.id}/read`, { threadId: threadA })).status).toBe(200);
    expect((await paired("POST", `/api/bots/${bot.id}/interrupt`, { threadId: threadA })).status).toBe(200);
    const branch = await paired("POST", `/api/bots/${bot.id}/active-branch`, { threadId: threadA, messageId: userA.id });
    expect(branch.status).toBe(200);
    expect((await page(threadA)).activeLeafId).toBe(branch.body.activeLeafId);
    const around = await paired("GET", `/api/threads/${threadA}/messages?around=${userA.id}`);
    expect(around.body.activeLeafId).toBe(branch.body.activeLeafId);
    expect((await page(threadB)).activeLeafId).toBe(beforeB.activeLeafId);
    const model = await paired("PATCH", `/api/bots/${bot.id}/tasks/${threadA}`, { modelSelection: selection(models[1]), requireAvailableModel: true });
    expect(model.status).toBe(200);
    expect(model.body.task.modelSelection).toEqual(selection(models[1]));
    expect(model.body.bot.threadId).toBe(threadB);
    expect(model.body.bot.modelSelection).toEqual(selection(models[0]));
    expect((await paired("POST", `/api/bots/${bot.id}/messages`, { threadId: threadA, text: "Captured A" })).status).toBe(202);
    await idle(bot.id);
    expect((await page(threadA)).messages.some((message: any) => message.text === "Captured A")).toBe(true);
    expect((await page(threadB)).messages).toEqual(beforeB.messages);
    expect((await paired("POST", `/api/bots/${bot.id}/messages/${userA.id}/edit`, { threadId: threadA, text: "Edited A" })).status).toBe(202);
    await idle(bot.id);
    expect((await page(threadB)).messages).toEqual(beforeB.messages);
    const missingGrant = await paired("POST", `/api/bots/${bot.id}/always-allow`, { threadId: threadA, allowKey: "Bash:ls" });
    expect(missingGrant.status).toBe(409);
    expect(missingGrant.body.error).toMatch(/not on a pending approval/);
    expect((await paired("DELETE", `/api/bots/${bot.id}/queue/not-a-queued-message`, { threadId: threadA })).status).toBe(404);
    // Local desktop/API compatibility remains intentionally selected-thread based.
    expect((await api("POST", `/api/bots/${bot.id}/read`)).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}/model`, selection(models[0]))).status).toBe(200);
  }, 60_000);

  it("keeps single-thread paired clients compatible and never grants authority to a spoofed marker", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Single thread", modelSelection: selection(models[0]) })).body.bot;
    expect((await paired("PATCH", `/api/bots/${bot.id}/model`, selection(models[1]))).status).toBe(200);
    expect((await paired("POST", `/api/bots/${bot.id}/messages`, { text: "Single-thread legacy send" })).status).toBe(202);
    await idle(bot.id);
    expect((await paired("POST", `/api/bots/${bot.id}/read`)).status).toBe(200);
    expect((await paired("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    const before = await page(bot.threadId);
    const spoofed = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Unauthorized", threadId: bot.threadId }, {
      "x-forwarded-for": "203.0.113.5",
      "x-openmausbot-companion": "1",
      "x-openmausbot-companion-device": "not-authenticated",
    });
    expect(spoofed.status).toBe(403);
    expect((await page(bot.threadId)).messages).toEqual(before.messages);
  });
});
