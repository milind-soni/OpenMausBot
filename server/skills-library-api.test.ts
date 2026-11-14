import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const SKILL_MD = [
  "---",
  "name: order-audit",
  "description: Audits an order before it ships.",
  "tags: orders, review",
  "---",
  "",
  "Check every line item against the packing slip before shipping.",
].join("\n");

describe("skills library routes through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let botId: string;
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    botId = (await api("POST", "/api/bots", { name: "Skills fixture" })).body.bot.id;
  });

  afterAll(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.skills-library.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("hides every library route while the flag is off and keeps the per-bot response shape", async () => {
    expect((await api("GET", "/api/skills-library")).status).toBe(404);
    expect((await api("PUT", `/api/bots/${botId}/skills-library`, { skills: ["order-audit"] })).status).toBe(404);
    const legacy = await api("GET", `/api/bots/${botId}/skills`);
    expect(legacy.status).toBe(200);
    expect(Object.keys(legacy.body).sort()).toEqual(["skills", "staged"]);
  });

  it("lists, imports, assigns, and reviews pasted skills once the flag is on", async () => {
    expect((await api("PATCH", "/api/config", { features: { skillsLibrary: true } })).status).toBe(200);

    expect(await api("GET", "/api/skills-library")).toMatchObject({ status: 200, body: { skills: [] } });

    const imported = await api("POST", "/api/skills-library", { text: SKILL_MD });
    expect(imported.status).toBe(201);
    expect(imported.body.skill).toMatchObject({ name: "order-audit" });

    const listed = await api("GET", "/api/skills-library");
    expect(listed.body.skills).toEqual([
      expect.objectContaining({
        name: "order-audit",
        source: "local-import",
        enabled: false,
        tags: ["orders", "review"],
        version: null,
        assignedBots: [],
      }),
    ]);

    expect((await api("POST", "/api/skills-library", { text: "not a skill" })).status).toBe(400);

    expect((await api("PUT", `/api/bots/${botId}/skills-library`, { skills: ["order-audit"] }))).toMatchObject({
      status: 200,
      body: { assignedSkills: ["order-audit"] },
    });
    const withSkill = await api("GET", `/api/bots/${botId}/skills`);
    expect(withSkill.body.skills).toEqual([expect.objectContaining({ name: "order-audit", origin: "library" })]);
    expect(withSkill.body.library).toEqual([]);
    expect(withSkill.body.assignedSkills).toEqual(["order-audit"]);

    expect((await api("PUT", `/api/bots/${botId}/skills-library`, { skills: ["nope"] })).status).toBe(422);

    expect((await api("PATCH", "/api/skills-library/order-audit", { enabled: true }))).toMatchObject({ status: 200 });
    expect((await api("PATCH", "/api/skills-library/order-audit", { everyBot: true }))).toMatchObject({ status: 200 });
    const text = await api("GET", "/api/skills-library/order-audit");
    expect(text.body.text).toContain("Check every line item");
    const enabled = await api("GET", "/api/skills-library");
    expect(enabled.body.skills[0]).toMatchObject({ enabled: true, everyBot: true });
    expect(enabled.body.skills[0].assignedBots).toEqual(expect.arrayContaining([{ id: botId, name: "Skills fixture" }]));
    expect((await api("PATCH", "/api/skills-library/order-audit", { everyBot: false }))).toMatchObject({ status: 200 });

    expect((await api("PUT", `/api/bots/${botId}/skills-library`, { skills: [] }))).toMatchObject({
      status: 200,
      body: { assignedSkills: [] },
    });
    const afterRemove = await api("GET", `/api/bots/${botId}/skills`);
    expect(afterRemove.body.skills).toEqual([]);
    expect(afterRemove.body.library.map((entry: { name: string }) => entry.name)).toEqual(["order-audit"]);
    expect(afterRemove.body.assignedSkills).toEqual([]);
  });
});
