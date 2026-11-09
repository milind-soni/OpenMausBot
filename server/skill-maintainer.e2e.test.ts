import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("transfers a shared skill's maintainer through the live turn capability without changing access", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow" });
  const base = fixture.info.url;
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  const dump = (): any => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  try {
    expect((await request("PATCH", "/api/config", { features: { skillsLibrary: true } })).status).toBe(200);
    const author = (await request("POST", "/api/bots", { name: "Author" })).body.bot;
    const target = (await request("POST", "/api/bots", { name: "Target" })).body.bot;
    const text = "---\nname: fixture-audit\ndescription: Audits a fixture.\n---\n\nReview it.\n";
    expect((await request("POST", "/api/skills-library", { text })).status).toBe(201);
    expect((await request("PATCH", "/api/skills-library/fixture-audit", { enabled: true })).status).toBe(200);
    for (const bot of [author, target]) {
      expect((await request("PUT", `/api/bots/${bot.id}/skills-library`, { skills: ["fixture-audit"] })).status).toBe(200);
    }
    expect((await request("POST", `/api/bots/${author.id}/messages`, { threadId: author.threadId, sendId: "maintainer-fixture-0001", text: "Start fixture" })).status).toBeLessThan(300);
    await expect.poll(() => dump().mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN, { timeout: hostTimeout(30_000) }).toBeTruthy();
    const token: string = dump().mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const listing = async () => (await request("GET", `/api/internal/skills?fromBotId=${author.id}&fromThreadId=${author.threadId}`, undefined, token)).body.skills.find((skill: { name: string }) => skill.name === "fixture-audit");
    const before = await listing();
    expect(before.shared).toMatchObject({ scope: "selected_bots", enabled: true, maintainer_status: "unassigned" });
    const transfer = { action: "transfer_maintainer", skill_name: "fixture-audit", target_bot_id: target.id, base_revision: before.shared.management_revision };
    const applied = await request("POST", "/api/internal/skills/stage", transfer, token);
    expect(applied).toMatchObject({ status: 200, body: { state: "applied", result: { maintainer_bot_id: target.id, maintainer_status: "assigned", enabled: true, scope: "selected_bots" } } });
    expect((await listing()).shared).toEqual(applied.body.result);
    expect((await request("POST", "/api/internal/skills/stage", transfer, token)).status).toBe(409);
    const library = (await request("GET", "/api/skills-library")).body.skills.find((skill: { name: string }) => skill.name === "fixture-audit");
    expect(library.assignedBots.map((bot: { id: string }) => bot.id).sort()).toEqual([author.id, target.id].sort());
    expect((await request("GET", "/api/skills-library/fixture-audit")).body.text).toBe(text);
  } finally {
    await fixture.close();
  }
}, hostTimeout(60_000));
