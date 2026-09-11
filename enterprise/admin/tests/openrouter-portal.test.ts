import { afterEach, beforeEach, expect, it } from "vitest";
import { launchFixture } from "./fixture.ts";

let fixture: Awaited<ReturnType<typeof launchFixture>>;
beforeEach(async () => { fixture = await launchFixture(); });
afterEach(async () => { await fixture.close(); });
const models = ["vendor/tool-model", "vendor/other-model"];
async function setup() {
  const admin = fixture.client();
  await admin.login("operator@example.test");
  expect((await admin.request("/api/providers/openrouter", "POST", { key: "synthetic-openrouter-master", models })).status).toBe(200);
  return admin;
}

it("saves independent providers, seeds scoped OpenCode access, and lists only assigned OpenRouter models", async () => {
  const admin = await setup();
  expect((await admin.request("/api/providers/anthropic", "POST", { key: "synthetic-anthropic-master", models: ["fixture-claude"] })).ok).toBe(true);
  const status = await (await admin.request("/api/providers")).json();
  expect(status.providers).toEqual([
    { id: "anthropic", configured: true, models: ["fixture-claude"] },
    { id: "openrouter", configured: true, models },
  ]);
  expect(JSON.stringify(status)).not.toContain("master");
  const created = await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha", openrouterModels: [models[0]] });
  expect(created.status, await created.clone().text()).toBe(201);
  const seed = fixture.calls.find(call => call.method === "POST" && call.path === "/workspaces")!.body as Record<string, unknown>;
  expect(seed).toMatchObject({
    openrouterUrl: `${fixture.url}/api/gateway/alpha/openrouter/v1`, openrouterModels: [models[0]], openrouterDefault: true,
  });
  expect(seed.openrouterKey).toBe(seed.anthropicKey);
  expect(seed.openrouterKey).not.toBe("synthetic-openrouter-master");
  const headers = { authorization: `Bearer ${seed.openrouterKey}` };
  const catalog = await admin.request("/api/gateway/alpha/openrouter/v1/models", "GET", undefined, headers);
  expect(catalog.status).toBe(200);
  expect((await catalog.json()).data.map((row: { id: string }) => row.id)).toEqual([models[0]]);
  const response = await admin.request("/api/gateway/alpha/openrouter/v1/chat/completions", "POST", { model: models[0], messages: [] }, headers);
  expect(response.status).toBe(200); await response.text();
  expect(fixture.upstream[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(fixture.upstream[0].headers.get("authorization")).toBe("Bearer synthetic-openrouter-master");
  expect(fixture.upstream[0].headers.get("x-api-key")).toBeNull();
  const listed = await (await admin.request("/api/workspaces")).json();
  expect(listed.workspaces[0]).toMatchObject({ models: [], openrouterModels: [models[0]] });
});

it("writes the existing workspace catalog before widening access, and keeps revocations if sync fails", async () => {
  const admin = await setup();
  await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha", openrouterModels: [models[0]] });
  fixture.faults.fleet = true;
  const failed = await admin.request("/api/workspaces/alpha/providers", "POST", { models: [], openrouterModels: [models[1]] });
  expect(failed.status).toBe(502);
  expect(fixture.portal.gateway.access("alpha", "openrouter")).toEqual([]);
  fixture.faults.fleet = false;
  const saved = await admin.request("/api/workspaces/alpha/providers", "POST", { models: [], openrouterModels: [models[1]] });
  expect(saved.status).toBe(200);
  expect(fixture.calls.findLast(call => call.path === "/workspaces/alpha/providers")).toMatchObject({ method: "POST", body: { models: [models[1]] } });
  expect(fixture.portal.gateway.access("alpha", "openrouter")).toEqual([models[1]]);
  // An older Anthropic-only API request must not silently clear OpenRouter.
  expect((await admin.request("/api/workspaces/alpha/providers", "POST", { models: [] })).ok).toBe(true);
  expect(fixture.portal.gateway.access("alpha", "openrouter")).toEqual([models[1]]);
});

it("does not grant a workspace administrator platform provider authority", async () => {
  const admin = await setup();
  await admin.request("/api/workspaces", "POST", { slug: "alpha", name: "Alpha" });
  fixture.store.db.prepare("INSERT INTO portal_member VALUES (?,?,?)").run("alpha", "client@example.test", "admin");
  const client = fixture.client(); await client.login("client@example.test");
  expect((await client.request("/api/providers/openrouter")).status).toBe(403);
  expect((await client.request("/api/providers/openrouter", "POST", { key: "bad", models })).status).toBe(403);
  expect((await client.request("/api/workspaces/alpha/providers", "POST", { models: [], openrouterModels: models })).status).toBe(403);
  expect((await admin.request("/api/workspaces/alpha/providers", "POST", { models: [], openrouterModels: ["unapproved/model"] })).ok).toBe(false);
  expect(fixture.portal.gateway.access("alpha", "openrouter")).toEqual([]);
});
