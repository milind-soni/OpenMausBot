import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

it("isolates stale skill-link failures to the affected responders", async () => {
  const provider = createServer(async (request, response) => {
    if (request.url === "/v1/models") return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    if (request.method === "GET") { response.statusCode = 404; return response.end(); }
    for await (const chunk of request) { void chunk; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Off-host fixture reply." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const fixture = await launchVerificationServer({});
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  try {
    const bot = async (name: string) => (await call("POST", "/api/bots", { name, useDefaults: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).bot;
    const first = await bot("First"), second = await bot("Second"), remote = await bot("Off host");
    const port = (provider.address() as { port: number }).port;
    await call("PATCH", "/api/config", { openaiCompat: { key: "fixture-key", url: `http://127.0.0.1:${port}/v1`, model: "fixture-model" } });
    await call("PATCH", `/api/bots/${remote.id}/model`, { instanceId: "openaiCompat", model: "fixture-model" });
    await call("POST", `/api/bots/${first.id}/skill-template`, {
      name: "fixture-skill", description: "A fixture.", source: "org:fixture", enabled: true, warnings: [],
      text: "---\nname: fixture-skill\ndescription: A fixture.\n---\nReviewed fixture.\n",
    });
    const root = join(fixture.info.dataDir, "workspaces", first.id);
    expect(existsSync(join(root, ".claude", "skills", "fixture-skill", "SKILL.md"))).toBe(true);
    const manifestFile = join(fixture.info.dataDir, "skill-state", first.id, "skills.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest["fixture-skill"].pendingRetirements = [{ identity: "fixture", hash: "a".repeat(64) }];
    writeFileSync(manifestFile, JSON.stringify(manifest));

    const room = (await call("POST", "/api/groups", { name: "Fixture round", memberIds: [first.id, second.id, remote.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } } })).group;
    await call("POST", `/api/groups/${room.id}/messages`, { text: "Hello team" });
    const messages = async () => ((await call("GET", "/api/bots?messages=40")).groups as any[]).find((g) => g.id === room.id)?.messages ?? [];
    await expect.poll(async () => (await messages()).some((message: any) => message.from?.botId === first.id && message.tool?.ok === false && /could not be synchronized safely/.test(message.tool.name)), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await messages()).some((message: any) => message.from?.botId === second.id && message.role === "bot" && message.kind === "text"), { timeout: 15_000 }).toBe(true);
    const rows = await messages();
    expect(rows.some((message: any) => message.from?.botId === first.id && message.tool?.ok === false && /could not be synchronized safely/.test(message.tool.name))).toBe(true);
    expect(rows.some((message: any) => message.from?.botId === first.id && message.role === "bot" && message.kind === "text")).toBe(false);
    await expect.poll(async () => (await messages()).some((message: any) => message.from?.botId === remote.id && message.text === "Off-host fixture reply."), { timeout: 15_000 }).toBe(true);

    const shared = (await call("POST", "/api/groups", { name: "Shared workspace", memberIds: [second.id, remote.id] })).group;
    await call("PATCH", `/api/groups/${shared.id}/setup`, { action: "complete", cwd: root, bulletin: "", defaultResponder: { kind: "everyone" } });
    await call("POST", `/api/groups/${shared.id}/messages`, { text: "Hello shared room" });
    const sharedMessages = async () => ((await call("GET", "/api/bots?messages=40")).groups as any[]).find((g) => g.id === shared.id)?.messages ?? [];
    await expect.poll(async () => (await sharedMessages()).some((message: any) => message.from?.botId === remote.id && message.text === "Off-host fixture reply."), { timeout: 15_000 }).toBe(true);
    const sharedRows = await sharedMessages();
    expect(sharedRows.some((message: any) => message.from?.botId === second.id && message.tool?.ok === false && /could not be synchronized safely/.test(message.tool.name))).toBe(true);
    expect(sharedRows.some((message: any) => message.from?.botId === second.id && message.role === "bot" && message.kind === "text")).toBe(false);
    expect(readFileSync(join(root, ".claude", "skills", "fixture-skill", "SKILL.md"), "utf8")).toContain("Reviewed fixture.");
  } finally {
    await fixture.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
}, 120_000);

it.skipIf(process.platform === "win32")("refuses a direct turn when a pinned workspace alias disappears before dispatch", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-skill-alias-"));
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_PROMPTS: prompts });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  try {
    const bot = (await call("POST", "/api/bots", { name: "Alias fixture", useDefaults: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).bot;
    await call("POST", `/api/bots/${bot.id}/skill-template`, {
      name: "fixture-skill", description: "A fixture.", source: "org:fixture", enabled: true, warnings: [],
      text: "---\nname: fixture-skill\ndescription: A fixture.\n---\nReviewed fixture.\n",
    });
    const root = join(fixture.info.dataDir, "workspaces", bot.id), alias = join(scratch, "workspace-alias");
    symlinkSync(root, alias);
    await call("PATCH", `/api/bots/${bot.id}`, { cwd: alias });
    await call("POST", `/api/bots/${bot.id}/messages`, { text: "Pin this workspace." });
    const current = async () => ((await call("GET", "/api/bots?messages=40")).bots as any[]).find((value) => value.id === bot.id);
    await expect.poll(async () => { const b = await current(); return !b.busy && b.messages.some((m: any) => m.role === "bot" && m.kind === "text"); }, { timeout: 15_000 }).toBe(true);
    const promptCount = () => existsSync(prompts) ? readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const before = promptCount();
    expect(before).toBeGreaterThan(0);

    const revision = "b".repeat(64), old = join(root, "skills", ".revisions", revision);
    mkdirSync(join(root, "skills", ".revisions"), { recursive: true });
    cpSync(join(root, "skills", "fixture-skill"), old, { recursive: true });
    for (const family of [".claude", ".agents", ".grok"]) {
      const link = join(root, family, "skills", "fixture-skill");
      unlinkSync(link);
      symlinkSync(old, link);
    }
    const manifestFile = join(fixture.info.dataDir, "skill-state", bot.id, "skills.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest["fixture-skill"].pendingRetirements = [{ identity: "fixture", hash: "a".repeat(64), revision }];
    writeFileSync(manifestFile, JSON.stringify(manifest));
    unlinkSync(alias);
    await call("POST", `/api/bots/${bot.id}/messages`, { text: "The alias is missing." });
    await expect.poll(async () => (await current()).messages.some((m: any) => m.tool?.ok === false && /could not be synchronized safely/.test(m.tool.name)), { timeout: 15_000 }).toBe(true);
    expect((await current()).busy).toBe(false);
    expect(promptCount()).toBe(before);
    expect(readFileSync(join(old, "SKILL.md"), "utf8")).toContain("Reviewed fixture.");
    symlinkSync(root, alias);
    await call("POST", `/api/bots/${bot.id}/messages`, { text: "The old link remains." });
    await expect.poll(async () => (await current()).messages.filter((m: any) => m.tool?.ok === false && /could not be synchronized safely/.test(m.tool.name)).length, { timeout: 15_000 }).toBe(2);
    expect(promptCount()).toBe(before);
    for (const family of [".claude", ".agents", ".grok"]) unlinkSync(join(root, family, "skills", "fixture-skill"));
    await call("POST", `/api/bots/${bot.id}/messages`, { text: "The old links are cleared." });
    await expect.poll(promptCount, { timeout: 15_000 }).toBeGreaterThan(before);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
