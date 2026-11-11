import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { installLibrarySkill, librarySkillOptOuts, readLibrarySkillFile, setLibrarySkillEveryBot } from "../skill-library.ts";
import type { Store } from "../store.ts";
import { installSkill, listSkills, resolveBotSkills } from "../skills.ts";
import { fakeGitHub } from "../testing/fake-github.ts";
import { workspaceDir } from "../workspace.ts";
import { createBotSkillsRoutes } from "./bot-skills.ts";
import { dispatchRoutes } from "./table.ts";

const SKILL = "---\nname: pdf-forms\ndescription: Fills PDF forms.\n---\n\n# PDF forms\nRead references/fields.md, then run scripts/fill.py.\n";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(botId: string) {
  const store = { bot: (id: string) => (id === botId ? { id } : undefined), bots: [] } as unknown as Store;
  const routes = [createBotSkillsRoutes({
    store,
    cfg: {} as AppConfig,
    listBotSkills: () => [],
    readBotSkillFile: () => null,
    stagedSkillListing: (staged) => staged,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("importing a skill from GitHub into a bot", () => {
  it("stores the whole folder with its origin and says what arrived and what was left out", async () => {
    const botId = `route-bot-${Math.random().toString(36).slice(2, 10)}`;
    const base = await serve(botId);
    const github = fakeGitHub({ "acme/skills": {
      "skills/pdf-forms/SKILL.md": SKILL,
      "skills/pdf-forms/references/fields.md": "# Fields\n",
      "skills/pdf-forms/scripts/fill.py": { content: "print('fill')\n", executable: true },
      "skills/pdf-forms/assets/form.pdf": Buffer.from("%PDF-1.7\n\u0000ÿ"),
      "skills/pdf-forms/shortcut.md": { link: "references/fields.md" },
    } }, { passThrough: fetch });
    vi.stubGlobal("fetch", github.fetch);

    const response = await fetch(`${base}/api/bots/${botId}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://github.com/acme/skills/tree/main/skills/pdf-forms" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { imported: unknown; installed: unknown };
    const commit = github.commitOf("acme/skills");
    expect(body.imported).toEqual([
      { name: "pdf-forms", files: 4, scripts: 1, skipped: [{ path: "shortcut.md", reason: "link" }], skippedCount: 1 },
    ]);
    expect(body.installed).toEqual([expect.objectContaining({
      name: "pdf-forms",
      enabled: false,
      files: ["assets/form.pdf", "references/fields.md", "scripts/fill.py"],
      github: { owner: "acme", repo: "skills", ref: "main", commit, path: "skills/pdf-forms" },
    })]);
    const folder = join(workspaceDir(botId), "skills", "pdf-forms");
    expect(readFileSync(join(folder, "references", "fields.md"), "utf8")).toBe("# Fields\n");
    expect(readFileSync(join(folder, "assets", "form.pdf"))).toEqual(Buffer.from("%PDF-1.7\n\u0000ÿ"));
    expect(existsSync(join(folder, "shortcut.md"))).toBe(false);
  });
});

const learned = (name: string) => `---\nname: ${name}\ndescription: A skill.\n---\n\n# ${name}\n\nSteps.\n`;

describe("removing a skill from one bot", () => {
  it("deletes a bot-owned skill, unassigns a shared one from that bot only, and refuses an imported one", async () => {
    const owned = `owned-${Math.random().toString(36).slice(2, 8)}`;
    const shared = `shared-${Math.random().toString(36).slice(2, 8)}`;
    const brought = `brought-${Math.random().toString(36).slice(2, 8)}`;
    const first = `bot-${Math.random().toString(36).slice(2, 8)}`;
    const second = `bot-${Math.random().toString(36).slice(2, 8)}`;
    const third = `bot-${Math.random().toString(36).slice(2, 8)}`;
    const bots = new Map([
      [first, { id: first, name: "First", assignedSkills: [shared] as string[] | undefined }],
      [second, { id: second, name: "Second", assignedSkills: [shared] as string[] | undefined }],
      [third, { id: third, name: "Third" }],
    ]);
    const text = learned(shared);
    expect(installSkill(first, "private:test", [{ path: "SKILL.md", content: learned(owned) }])).toMatchObject({ name: owned });
    expect(installLibrarySkill({ name: shared, instructions: text, source: "lib", reviewState: "approved" })).toMatchObject({ name: shared });
    expect(setLibrarySkillEveryBot(shared, true)).toMatchObject({ everyBot: true });
    const store = {
      bot: (id: string) => bots.get(id),
      get bots() { return [...bots.values()]; },
      patchBot(id: string, patch: { assignedSkills?: string[] }) {
        const bot = bots.get(id);
        if (!bot) return null;
        Object.assign(bot, patch);
        return bot;
      },
    } as unknown as Store;
    const routes = [createBotSkillsRoutes({
      store,
      cfg: { features: { skillsLibrary: true } } as AppConfig,
      listBotSkills: () => [
        { name: brought, origin: "imported" },
        { name: "engine-notes", origin: "native" },
      ] as never,
      readBotSkillFile: () => null,
      stagedSkillListing: (staged) => staged,
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string) => {
      const response = await fetch(`${base}${path}`, { method });
      return { status: response.status, body: await response.json() as { error?: string; skills?: Array<{ name: string }> } };
    };

    expect((await call("DELETE", `/api/bots/${first}/skills/${owned}`)).status).toBe(200);
    expect(listSkills(first).map((skill) => skill.name)).not.toContain(owned);

    expect((await call("DELETE", `/api/bots/${first}/skills/${shared}`)).status).toBe(200);
    expect(bots.get(first)!.assignedSkills).toEqual([]);
    expect(bots.get(second)!.assignedSkills).toEqual([shared]);
    expect(readLibrarySkillFile(shared)).toBe(text);
    expect(resolveBotSkills(first, []).map((skill) => skill.name)).not.toContain(shared);
    expect(resolveBotSkills(second, [shared]).map((skill) => skill.name)).toContain(shared);
    expect(resolveBotSkills(third, []).map((skill) => skill.name)).toContain(shared);
    expect((await call("GET", `/api/bots/${first}/skills`)).body.skills?.map((skill) => skill.name)).not.toContain(shared);

    const refused = await call("DELETE", `/api/bots/${first}/skills/${brought}`);
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatch(/can't be removed from one bot/);
    const native = await call("DELETE", `/api/bots/${first}/skills/engine-notes`);
    expect(native.status).toBe(404);
    expect(native.body.error).toMatch(/can't be removed here/);
    expect((await call("DELETE", `/api/bots/${first}/skills/missing-skill`)).status).toBe(404);

    const put = await fetch(`${base}/api/bots/${first}/skills-library`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: [shared] }),
    });
    expect(put.status).toBe(200);
    const cleared = await fetch(`${base}/api/bots/${first}/skills-library`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: [] }),
    });
    expect(cleared.status).toBe(200);
    expect(resolveBotSkills(first, []).map((skill) => skill.name)).toContain(shared);
  });

  it("returns the remove error and leaves the shared assignment when a private skill cannot be removed", async () => {
    const name = `shadow-${Math.random().toString(36).slice(2, 8)}`;
    const botId = `bot-${Math.random().toString(36).slice(2, 8)}`;
    const bot = { id: botId, name: "Shadow", assignedSkills: [name] as string[] };
    const text = learned(name);
    expect(installSkill(botId, "private:test", [{ path: "SKILL.md", content: text }])).toMatchObject({ name });
    expect(installLibrarySkill({ name, instructions: text, source: "lib", reviewState: "approved" })).toMatchObject({ name });
    expect(setLibrarySkillEveryBot(name, true)).toMatchObject({ everyBot: true });
    const root = workspaceDir(botId);
    const skillsRoot = join(root, "skills");
    const outside = join(root, "outside-skills");
    mkdirSync(outside, { recursive: true });
    rmSync(skillsRoot, { recursive: true, force: true });
    symlinkSync(outside, skillsRoot, process.platform === "win32" ? "junction" : "dir");
    const store = {
      bot: (id: string) => (id === botId ? bot : undefined),
      get bots() { return [bot]; },
      patchBot(id: string, patch: { assignedSkills?: string[] }) {
        if (id !== botId) return null;
        Object.assign(bot, patch);
        return bot;
      },
    } as unknown as Store;
    const routes = [createBotSkillsRoutes({
      store,
      cfg: { features: { skillsLibrary: true } } as AppConfig,
      listBotSkills: () => [],
      readBotSkillFile: () => null,
      stagedSkillListing: (staged) => staged,
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/api/bots/${botId}/skills/${name}`, { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "the workspace skills path is a symlink or file; refusing to remove through it" });
      expect(bot.assignedSkills).toEqual([name]);
      expect(librarySkillOptOuts(botId).has(name)).toBe(false);
      expect(listSkills(botId).map((skill) => skill.name)).toContain(name);
      expect(readLibrarySkillFile(name)).toBe(text);
    } finally {
      expect(setLibrarySkillEveryBot(name, false)).toMatchObject({ everyBot: false });
    }
  });
});
