import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import { provideGithubSignIn } from "../github/token.ts";
import { json, readBody } from "../harness/http.ts";
import { IMPORTED_SKILLS_DIR, importedSkillListings, importedSkillsFor, readImportedSkillFile, readImportedSkills, storeImportedSkills } from "../imported-skills.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { installLibrarySkill, readLibrarySkillFile, setLibrarySkillEveryBot } from "../skill-library.ts";
import type { Store } from "../store.ts";
import { installSkill, listSkills, readSkillFile, resolveBotSkills, skillsSystemPrompt } from "../skills.ts";
import { fakeGitHub } from "../testing/fake-github.ts";
import { workspaceDir } from "../workspace.ts";
import { createBotSkillsRoutes } from "./bot-skills.ts";
import { dispatchRoutes } from "./table.ts";

const SKILL = "---\nname: pdf-forms\ndescription: Fills PDF forms.\n---\n\n# PDF forms\nRead references/fields.md, then run scripts/fill.py.\n";

const servers: Server[] = [];
afterEach(async () => {
  provideGithubSignIn(null);
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(botId: string) {
  const store = { bot: (id: string) => (id === botId ? { id } : undefined), bots: [] } as unknown as Store;
  const routes = [createBotSkillsRoutes({
    store,
    cfg: {} as AppConfig,
    listBotSkills: (bot) => listSkills(bot.id),
    readBotSkillFile: (bot, name) => readSkillFile(bot.id, name),
    stagedSkillListing: (staged) => staged,
    team: false,
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
  it.each([
    ["a BOM at the repository root", `\uFEFF${SKILL}`, ""],
    ["a BOM and CRLF in a differently named folder", `\uFEFF${SKILL.replaceAll("\n", "\r\n")}`, "skills/form-helper"],
    ["a capitalized frontmatter key", SKILL.replace("name:", "Name:"), "skills/form-helper"],
    ["a quoted skill name", SKILL.replace("name: pdf-forms", 'name: "pdf-forms"'), "skills/form-helper"],
    ["a folder matching the requested name", `\uFEFF${SKILL}`, "skills/pdf-forms"],
  ])("imports a named skills.sh skill with %s and makes it available after review", async (_label, text, directory) => {
    const botId = `route-bot-${Math.random().toString(36).slice(2, 10)}`;
    const base = await serve(botId);
    const prefix = directory ? `${directory}/` : "";
    const github = fakeGitHub({ "acme/skills": {
      [`${prefix}SKILL.md`]: text,
      [`${prefix}references/fields.md`]: "# Fields\nUse the invoice number.\n",
    } }, { passThrough: fetch });
    vi.stubGlobal("fetch", github.fetch);

    const imported = await fetch(`${base}/api/bots/${botId}/skills`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://skills.sh/acme/skills/pdf-forms" }),
    });
    const result = await imported.json();
    expect(imported.status, JSON.stringify(result)).toBe(201);
    expect(result).toMatchObject({ installed: [expect.objectContaining({
      name: "pdf-forms", enabled: false,
      github: { owner: "acme", repo: "skills", ref: "HEAD", commit: github.commitOf("acme/skills"), path: directory },
    })] });
    const read = await fetch(`${base}/api/bots/${botId}/skills/pdf-forms`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ text: text.replace(/^\uFEFF/, "") });
    expect(readFileSync(join(workspaceDir(botId), "skills/pdf-forms/references/fields.md"), "utf8"))
      .toBe("# Fields\nUse the invoice number.\n");
    expect(skillsSystemPrompt(botId)).not.toContain("pdf-forms");
    const enabled = await fetch(`${base}/api/bots/${botId}/skills/pdf-forms`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(skillsSystemPrompt(botId)).toContain("pdf-forms");
    const listing = await fetch(`${base}/api/bots/${botId}/skills`);
    expect(await listing.json()).toMatchObject({ skills: [expect.objectContaining({ name: "pdf-forms", enabled: true })] });
  });

  it("does not install a different named skill when the requested skills.sh name is missing", async () => {
    const botId = `route-bot-${Math.random().toString(36).slice(2, 10)}`;
    const base = await serve(botId);
    const github = fakeGitHub({ "acme/skills": { "skills/form-helper/SKILL.md": `\uFEFF${SKILL}` } }, { passThrough: fetch });
    vi.stubGlobal("fetch", github.fetch);
    const response = await fetch(`${base}/api/bots/${botId}/skills`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://skills.sh/acme/skills/another-skill" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining('no skill named "another-skill"') });
    expect(listSkills(botId)).toEqual([]);
  });

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

describe("whose GitHub sign-in a bot import uses", () => {
  const TOKEN = "gho_syntheticSkillImportToken";
  const OWNER = "gho_ownerSignInMustNotLeak";
  const SKILL_MD = "---\nname: pdf\ndescription: Does pdf things.\n---\n\n# pdf\n";

  async function importAs(auth: RequestAuth, team = false) {
    const asked: Array<string | null | undefined> = [];
    provideGithubSignIn({
      token: async (audience) => { asked.push(audience); return audience ? TOKEN : OWNER; },
      reportAuthFailure: () => {},
      signedIn: () => true,
    });
    const botId = `route-auth-${Math.random().toString(36).slice(2, 10)}`;
    const realFetch = globalThis.fetch;
    const github = fakeGitHub({ "acme/skills": { "skills/pdf/SKILL.md": SKILL_MD } });
    const calls: Array<{ url: string; headers: Headers }> = [];
    const recording: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return github.fetch(input, init);
    };
    vi.stubGlobal("fetch", recording);
    const store = { bot: (id: string) => (id === botId ? { id } : undefined), bots: [] } as unknown as Store;
    const routes = [createBotSkillsRoutes({
      store,
      cfg: {} as AppConfig,
      listBotSkills: () => [],
      readBotSkillFile: () => null,
      stagedSkillListing: (staged) => staged,
      team,
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const response = await realFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/${botId}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "acme/skills" }),
    });
    const body = await response.json() as { error?: string };
    return { status: response.status, body, calls, asked };
  }

  it("sends the owner sign-in on API requests for an owner or admin", async () => {
    const { status, body, calls, asked } = await importAs({ kind: "loopback", scopes: ["admin"] } as RequestAuth);
    expect(status).toBe(201);
    const api = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
    const raw = calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"));
    expect(api.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    expect(api.every((call) => call.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(raw.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(asked).toContain("owner");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
  });

  it("stays anonymous when this request may not use the server sign-in, even if that sign-in exists", async () => {
    const { status, body, calls, asked } = await importAs({ kind: "loopback", scopes: ["admin"], trust: "service" } as RequestAuth);
    expect(status).toBe(201);
    expect(calls.some((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(calls.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(asked).toEqual([]);
    expect(JSON.stringify({ body, calls })).not.toContain(OWNER);
    expect(JSON.stringify({ body, calls })).not.toContain(TOKEN);
  });

  const memberSession = (email: string): RequestAuth => ({
    kind: "session",
    via: "cookie",
    scopes: ["client"],
    session: {
      id: "s-1", tokenHash: "0".repeat(64), label: "Ada", scopes: ["client"], createdAt: 1, lastSeenAt: 1, expiresAt: 9_000,
      email, teamRole: "member", membershipAuthority: "team",
    } as SessionRecord,
  });

  it("asks for that member's person key on a Team Cloud", async () => {
    const key = personKey({ id: "", email: "ada@example.com" });
    const { status, body, calls, asked } = await importAs(memberSession("ada@example.com"), true);
    expect(status).toBe(201);
    const api = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
    const raw = calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"));
    expect(api.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    expect(asked).toEqual([key]);
    expect(api.every((call) => call.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(raw.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("does not look up a token on a Team Cloud when this session has no member sign-in", async () => {
    const { status, calls, asked } = await importAs({ kind: "loopback", scopes: ["admin"] } as RequestAuth, true);
    expect(status).toBe(201);
    expect(calls.some((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(asked).toEqual([]);
    expect(calls.every((call) => call.headers.get("authorization") === null)).toBe(true);
  });
});

const learned = (name: string) => `---\nname: ${name}\ndescription: A skill.\n---\n\n# ${name}\n\nSteps.\n`;

/** One skill from this computer, kept in the real imported store; its source folder is made unless `withSource` is false. */
function storeImported(name: string, sourceFolder: string, withSource = true): string {
  const text = learned(name);
  if (withSource) {
    mkdirSync(sourceFolder, { recursive: true });
    writeFileSync(join(sourceFolder, "SKILL.md"), text);
  }
  expect(storeImportedSkills([{
    name,
    skillMd: text,
    files: [],
    entry: {
      description: "A skill.",
      source: "claudeCode",
      root: dirname(sourceFolder),
      origin: sourceFolder,
      label: sourceFolder,
      sha256: createHash("sha256").update(text).digest("hex"),
      warnings: [],
    },
  }])).toMatchObject([{ name, stored: true }]);
  return text;
}

describe("removing a skill from one bot", () => {
  it("deletes a bot-owned skill, unassigns a shared one from that bot only, removes an imported one for that bot, and clears a stale import", async () => {
    const owned = `owned-${Math.random().toString(36).slice(2, 8)}`;
    const shared = `shared-${Math.random().toString(36).slice(2, 8)}`;
    const brought = `brought-${Math.random().toString(36).slice(2, 8)}`;
    const stale = `stale-${Math.random().toString(36).slice(2, 8)}`;
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
    const broughtSource = join(DATA_DIR, "test-source-skills", brought);
    const broughtText = storeImported(brought, broughtSource);
    storeImported(stale, join(DATA_DIR, "test-source-skills", stale), false);
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
      listBotSkills: (bot) => [
        ...importedSkillListings(bot.id, new Set()),
        { name: "engine-notes", origin: "native" },
      ] as never,
      readBotSkillFile: () => null,
      stagedSkillListing: (staged) => staged,
      team: false,
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
    const patch = async (botId: string, name: string, enabled: boolean) => {
      const response = await fetch(`${base}/api/bots/${botId}/skills/${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      return { status: response.status, body: await response.json() as { skill?: { name: string; enabled: boolean } } };
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

    const removed = await call("DELETE", `/api/bots/${first}/skills/${brought}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, scope: "bot", sourceFilesTouched: false });
    expect(importedSkillListings(first, new Set()).map((skill) => skill.name)).not.toContain(brought);
    expect((await call("GET", `/api/bots/${first}/skills`)).body.skills?.map((skill) => skill.name)).not.toContain(brought);
    expect(importedSkillListings(second, new Set()).map((skill) => skill.name)).toContain(brought);
    expect(importedSkillsFor(second, new Set()).map((skill) => skill.name)).toContain(brought);
    expect(readImportedSkillFile(brought)).toBe(broughtText);
    expect(readFileSync(join(broughtSource, "SKILL.md"), "utf8")).toBe(broughtText);
    expect(readImportedSkills()[brought]).toBeDefined();
    // The one copy every bot shares is only cleared when its source folder is gone.
    const kept = await call("DELETE", `/api/bots/${second}/skills/${brought}?scope=all-bots`);
    expect(kept.status).toBe(409);
    expect(kept.body.error).toMatch(/still has its source folder/);
    expect(readImportedSkills()[brought]).toBeDefined();

    const cleared = await call("DELETE", `/api/bots/${first}/skills/${stale}?scope=all-bots`);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true, scope: "all-bots", sourceFilesTouched: false });
    expect(readImportedSkills()[stale]).toBeUndefined();
    expect(existsSync(join(IMPORTED_SKILLS_DIR, stale))).toBe(false);
    expect((await call("GET", `/api/bots/${second}/skills`)).body.skills?.map((skill) => skill.name)).not.toContain(stale);

    // The switch still works for an imported skill another bot keeps, and brings one back to the bot it was removed from.
    expect(await patch(second, brought, false)).toMatchObject({ status: 200, body: { skill: { name: brought, enabled: false } } });
    expect(importedSkillsFor(second, new Set()).map((skill) => skill.name)).not.toContain(brought);
    expect(await patch(second, brought, true)).toMatchObject({ status: 200, body: { skill: { name: brought, enabled: true } } });
    expect(importedSkillsFor(second, new Set()).map((skill) => skill.name)).toContain(brought);
    expect(await patch(first, brought, true)).toMatchObject({ status: 200, body: { skill: { name: brought, enabled: true } } });
    expect(importedSkillListings(first, new Set()).map((skill) => skill.name)).toContain(brought);

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
    const clearedAssignments = await fetch(`${base}/api/bots/${first}/skills-library`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: [] }),
    });
    expect(clearedAssignments.status).toBe(200);
    expect(resolveBotSkills(first, []).map((skill) => skill.name)).toContain(shared);
  });

  async function twinFixture(botId: string, name: string) {
    const bot = { id: botId, name: "Twin", assignedSkills: [name] as string[] | undefined };
    expect(installSkill(botId, "private:test", [{ path: "SKILL.md", content: learned(name) }])).toMatchObject({ name });
    expect(installLibrarySkill({ name, instructions: learned(name), source: "lib", reviewState: "approved" })).toMatchObject({ name });
    const store = {
      bot: (id: string) => (id === botId ? bot : undefined),
      get bots() { return [bot]; },
      patchBot(_id: string, patch: { assignedSkills?: string[] }) { return Object.assign(bot, patch); },
    } as unknown as Store;
    const routes = [createBotSkillsRoutes({
      store,
      cfg: { features: { skillsLibrary: true } } as AppConfig,
      listBotSkills: () => [],
      readBotSkillFile: () => null,
      stagedSkillListing: (staged) => staged,
      team: false,
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const remove = async () => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/${botId}/skills/${name}`, { method: "DELETE" });
      return { status: response.status, error: (await response.json() as { error?: string }).error };
    };
    return { bot, remove };
  }

  it("refuses a private skill it cannot remove instead of unassigning the shared skill of the same name", async () => {
    const { bot, remove } = await twinFixture("route-twin-unsafe-root", "twin-unsafe-root");
    const skillsRoot = join(workspaceDir(bot.id), "skills");
    renameSync(skillsRoot, `${skillsRoot}-real`);
    symlinkSync(`${skillsRoot}-real`, skillsRoot, process.platform === "win32" ? "junction" : "dir");

    expect(await remove()).toMatchObject({ status: 409, error: expect.stringMatching(/refusing to remove/) });
    expect(bot.assignedSkills).toEqual(["twin-unsafe-root"]);
    expect(listSkills(bot.id).map((skill) => skill.name)).toContain("twin-unsafe-root");
  });
});

describe("a bot's opt-outs from every-bot skills", () => {
  const optOutFile = (botId: string) => join(DATA_DIR, "skill-state", botId, "library-opt-out.json");

  it("keeps every-bot skills on for a bot whose opt-out list is damaged or can't be read", () => {
    const shared = "everyone-opt-out-check";
    expect(installLibrarySkill({ name: shared, instructions: learned(shared), source: "lib", reviewState: "approved" })).toMatchObject({ name: shared });
    expect(setLibrarySkillEveryBot(shared, true)).toMatchObject({ everyBot: true });
    mkdirSync(dirname(optOutFile("opt-out-damaged")), { recursive: true });
    writeFileSync(optOutFile("opt-out-damaged"), "[\"half-written");

    expect(resolveBotSkills("opt-out-none", []).map((skill) => skill.name)).toContain(shared);
    expect(resolveBotSkills("opt-out-damaged", []).map((skill) => skill.name)).toContain(shared);
    expect(resolveBotSkills("opt-out-damaged", [shared]).map((skill) => skill.name)).toContain(shared);

    if (process.platform === "win32" || process.getuid?.() === 0) return;
    mkdirSync(dirname(optOutFile("opt-out-unreadable")), { recursive: true });
    writeFileSync(optOutFile("opt-out-unreadable"), "[]");
    chmodSync(dirname(optOutFile("opt-out-unreadable")), 0o000);
    try {
      expect(resolveBotSkills("opt-out-unreadable", []).map((skill) => skill.name)).toContain(shared);
    } finally {
      chmodSync(dirname(optOutFile("opt-out-unreadable")), 0o700);
    }
  });
});
