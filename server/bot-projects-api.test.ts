import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("organizational folders through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let models: string[];
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
  const selection = (model: string) => ({ instanceId: "claude", model });
  const getBot = async (botId: string) => (await api("GET", "/api/bots?messages=30")).body.bots.find((bot: any) => bot.id === botId);
  const persistedBot = (botId: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === botId);

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    const wrapper = join(fixture.info.dataDir, "project-fixture.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_CLAUDE_MODE = "hang";',
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    const catalog = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "claude");
    models = catalog.models.options.map((model: any) => model.id);
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.projects.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("moves a live thread between folders without changing its model or deleting history", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Project fixture", modelSelection: selection(models[0]) })).body.bot;
    const originalThread = bot.threadId;
    const created = await api("POST", `/api/bots/${bot.id}/projects`, { name: "  Website  ", emoji: "🖥️" });
    expect(created.status).toBe(201);
    expect(created.body.project).toEqual({ id: expect.any(String), name: "Website", emoji: "🖥️" });
    const projectId = created.body.project.id;
    const other = (await api("POST", `/api/bots/${bot.id}/projects`, { name: "Research", emoji: "🔬" })).body.project;
    const first = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Landing page", projectId })).body.task;
    expect(first).toMatchObject({ projectId, modelSelection: selection(models[0]) });
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${first.threadId}`, { modelSelection: selection(models[1]) })).status).toBe(200);
    expect(first.cwd).toBeUndefined();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: first.threadId, text: "Keep this project's conversation" })).status).toBe(202);
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "fake-claude-dump.json"))).toBe(true);
    expect((await getBot(bot.id)).tasks.find((task: any) => task.threadId === first.threadId).busy).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}/projects/${projectId}`, { name: "Site" })).status).toBe(200);
    const moved = await api("PATCH", `/api/bots/${bot.id}/tasks/${first.threadId}`, { projectId: other.id });
    expect(moved.status).toBe(200);
    expect(moved.body.task).toMatchObject({ projectId: other.id, modelSelection: selection(models[1]), busy: true });
    expect(moved.body.bot.modelSelection).toEqual(selection(models[0]));
    const ungrouped = await api("DELETE", `/api/bots/${bot.id}/projects/${other.id}`);
    expect(ungrouped.status).toBe(200);
    const retained = ungrouped.body.bot.tasks.find((task: any) => task.threadId === first.threadId);
    expect(retained.projectId).toBeUndefined();
    expect(retained.modelSelection).toEqual(selection(models[1]));
    expect(retained.busy).toBe(true);
    expect(ungrouped.body.bot.projects).toEqual([{ id: projectId, name: "Site", emoji: "🖥️" }]);
    expect(ungrouped.body.bot.messages.some((message: any) => message.text === "Keep this project's conversation")).toBe(true);
    const next = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Next task", projectId })).body.task;
    expect(next.modelSelection).toEqual(selection(models[0]));
    expect(next.cwd).toBeUndefined();
    expect((await api("PATCH", `/api/bots/${bot.id}/projects/${projectId}`, { modelSelection: null })).status).toBe(400);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: first.threadId })).status).toBe(200);
    await expect.poll(async () => (await getBot(bot.id)).busy).toBe(false);
    expect((await getBot(bot.id)).tasks.some((task: any) => task.threadId === originalThread)).toBe(true);
  });

  it("creates empty folders, saves and clears emoji, and persists their chosen order", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Folder metadata" })).body.bot;
    const before = await getBot(bot.id);
    const plain = (await api("POST", `/api/bots/${bot.id}/projects`, { name: "Plain", emoji: null })).body.project;
    const emoji = (await api("POST", `/api/bots/${bot.id}/projects`, { name: "Emoji", emoji: "👩🏽‍💻" })).body.project;
    const flag = (await api("POST", `/api/bots/${bot.id}/projects`, { name: "Flag", emoji: "🇮🇳" })).body.project;
    expect(plain).not.toHaveProperty("emoji");
    expect(emoji.emoji).toBe("👩🏽‍💻");
    expect(flag.emoji).toBe("🇮🇳");
    let fresh = await getBot(bot.id);
    expect(fresh.tasks).toEqual(before.tasks);
    expect(fresh.threadId).toBe(before.threadId);
    expect(fresh.messages).toEqual(before.messages);
    expect(persistedBot(bot.id).projects).toEqual([plain, emoji, flag]);

    const order = [flag.id, plain.id, emoji.id];
    const reordered = await api("PATCH", `/api/bots/${bot.id}/projects/order`, { projectIds: order });
    expect(reordered.status).toBe(200);
    expect(reordered.body.projects).toEqual([flag, plain, emoji]);
    expect(reordered.body.bot.projects).toEqual(reordered.body.projects);
    fresh = await getBot(bot.id);
    expect(fresh.projects).toEqual([flag, plain, emoji]);
    expect(persistedBot(bot.id).projects).toEqual(fresh.projects);

    const changed = await api("PATCH", `/api/bots/${bot.id}/projects/${emoji.id}`, { emoji: "👍🏽" });
    expect(changed.status).toBe(200);
    expect(changed.body.project).toEqual({ ...emoji, emoji: "👍🏽" });
    expect((await getBot(bot.id)).projects[2].emoji).toBe("👍🏽");
    expect(persistedBot(bot.id).projects[2].emoji).toBe("👍🏽");
    const cleared = await api("PATCH", `/api/bots/${bot.id}/projects/${emoji.id}`, { emoji: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.project).toEqual({ id: emoji.id, name: emoji.name });
    fresh = await getBot(bot.id);
    expect(fresh.projects.map((project: any) => project.id)).toEqual(order);
    expect(fresh.projects[2]).not.toHaveProperty("emoji");
    expect(fresh.projects[0].emoji).toBe("🇮🇳");
    expect(persistedBot(bot.id).projects).toEqual(fresh.projects);
    expect(fresh.tasks).toEqual(before.tasks);
    expect(fresh.threadId).toBe(before.threadId);
  });

  it("rejects incomplete, duplicate, foreign and malformed reorder requests and invalid emoji", async () => {
    const owner = (await api("POST", "/api/bots", { name: "Order owner" })).body.bot;
    const sibling = (await api("POST", "/api/bots", { name: "Order sibling" })).body.bot;
    expect((await api("PATCH", `/api/bots/${owner.id}/projects/order`, { projectIds: [] })).body.projects).toEqual([]);
    const first = (await api("POST", `/api/bots/${owner.id}/projects`, { name: "First", emoji: "📁" })).body.project;
    const second = (await api("POST", `/api/bots/${owner.id}/projects`, { name: "Second", emoji: "⭐" })).body.project;
    const foreign = (await api("POST", `/api/bots/${sibling.id}/projects`, { name: "Foreign" })).body.project;
    for (const projectIds of [[], [first.id], [first.id, first.id], [first.id, foreign.id], [first.id, "missing"], [first.id, second.id, foreign.id], "wrong-type", [first.id, 2]]) {
      expect((await api("PATCH", `/api/bots/${owner.id}/projects/order`, { projectIds })).status).toBe(400);
    }
    for (const body of [null, [], {}, { projectIds: [first.id, second.id], name: "Unsupported" }]) {
      expect((await api("PATCH", `/api/bots/${owner.id}/projects/order`, body)).status).toBe(400);
    }
    expect((await api("PATCH", "/api/bots/missing-bot/projects/order", { projectIds: [] })).status).toBe(404);
    for (const emoji of ["", "folder", "📁📁", "📁\n", "1", "🏽", "🇮", "x".repeat(65), 1, {}]) {
      expect((await api("POST", `/api/bots/${owner.id}/projects`, { name: "Invalid", emoji })).status).toBe(400);
      expect((await api("PATCH", `/api/bots/${owner.id}/projects/${first.id}`, { name: "Should not change", emoji })).status).toBe(400);
    }
    expect((await api("PATCH", `/api/bots/${sibling.id}/projects/${first.id}`, { emoji: "❤️" })).status).toBe(404);
    expect((await getBot(owner.id)).projects).toEqual([first, second]);
    expect(persistedBot(owner.id).projects).toEqual([first, second]);
  });

  it("validates metadata and prevents project references crossing bot ownership", async () => {
    const owner = (await api("POST", "/api/bots", { name: "Owner" })).body.bot;
    const sibling = (await api("POST", "/api/bots", { name: "Sibling" })).body.bot;
    const project = (await api("POST", `/api/bots/${owner.id}/projects`, { name: "Private group" })).body.project;
    expect((await api("POST", `/api/bots/${owner.id}/projects`, { name: " " })).status).toBe(400);
    expect((await api("POST", `/api/bots/${owner.id}/projects`, { name: "x".repeat(81) })).status).toBe(400);
    expect((await api("POST", `/api/bots/${owner.id}/projects`, { name: "No folder", cwd: "/tmp" })).status).toBe(400);
    expect((await api("POST", `/api/bots/${owner.id}/projects`, { name: "No model defaults", modelSelection: selection(models[0]) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${owner.id}/projects/${project.id}`, { modelSelection: selection(models[0]) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${owner.id}/projects/${project.id}`, { modelSelection: selection("not-in-catalog"), requireAvailableModel: true })).status).toBe(400);
    expect((await api("POST", `/api/bots/${sibling.id}/tasks`, { projectId: project.id })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${sibling.id}/tasks/${sibling.threadId}`, { projectId: project.id })).status).toBe(400);
    expect((await api("DELETE", `/api/bots/${sibling.id}/projects/${project.id}`)).status).toBe(404);
    expect((await api("PATCH", `/api/bots/${sibling.id}/projects/${project.id}`, { name: "Wrong owner" })).status).toBe(404);
    expect((await getBot(owner.id)).projects).toEqual([project]);
  });
});
