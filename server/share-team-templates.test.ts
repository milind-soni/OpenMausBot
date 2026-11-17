import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShareGithubAccess } from "./host/share-github-access.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createShareRoutes, createShareToolRoute, importSource, type ShareToolContext } from "./routes/share.ts";
import { PASS } from "./routes/table.ts";
import { GithubTemplateError } from "./share-github.ts";
import { CONNECT_GITHUB, repoFolder, repoFolderOf, repoName, type GithubConnection } from "./share-github-repo.ts";
import { createCommunityPublisher } from "./share-publish.ts";
import { createShareHost } from "./share.ts";
import type { BotRecord } from "./store.ts";
import { createTeamTemplates, teamTemplatesFolder } from "./team-templates.ts";
import { fakeGithubRepo } from "./testing/fake-composio-github.ts";

const SKILL = "---\nname: report\ndescription: Weekly report.\n---\n\n# Report\n\nRun scripts/report.py.\n";
const SCRIPT = "import os\nprint(os.environ.get('WEEK', 'this week'))\n";
const TOKEN = `ghp_${"z".repeat(36)}`;
const folders: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-templates-"));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const helper = { id: "bot-1", name: "Reporter", title: "Weekly reports", color: "blue" } as BotRecord;
const ADMIN = { kind: "session", scopes: ["admin", "client"], via: "bearer", session: { id: "s1", email: "olive@acme.test" } } as unknown as RequestAuth;
const MEMBER = { kind: "session", scopes: ["client"], via: "bearer", session: { id: "s2", email: "rui@acme.test" } } as unknown as RequestAuth;

function setup(options: { team?: boolean; github?: GithubConnection; fetchTemplate?: () => Promise<never> } = {}) {
  const dataDir = scratch(), botFolder = scratch();
  const publisher = createCommunityPublisher({ access: () => null, selfHosted: true });
  const host = createShareHost({
    dataDir, bots: () => [helper], groups: () => [], routines: () => [], brief: () => undefined,
    collectTeamSkills: () => ({ ok: true, skipped: [], skillsByBot: new Map([["bot-1", [{ name: "report", description: "Weekly report.", instructions: SKILL, enabled: true }]]]) }),
    skillFiles: () => [{ path: "scripts/report.py", content: SCRIPT }], picture: () => undefined, botFolder: (id) => join(botFolder, id), publisher, patch: () => {},
  });
  let added = 0;
  const library = options.team === false ? null : { team: "Acme", templates: createTeamTemplates(dataDir, () => 1_700_000_000_000 + added++) };
  const view = { publicBot: (bot: BotRecord) => bot as never, publicGroup: (group: never) => group, broadcast: () => {} };
  const importDeps = async () => { throw new Error("not added in this test"); };
  const github = async () => options.github ?? { ok: false as const, reason: "not_connected" as const, message: CONNECT_GITHUB };
  const fetchTemplate = options.fetchTemplate ?? (async () => { throw new GithubTemplateError("Nothing was found at that GitHub link.", 404); });
  const routes = createShareRoutes({
    host, localFolders: false, ...view, library, github, fetchTemplate, bots: () => [helper], routines: () => [], importDeps,
    who: (auth) => (auth.kind === "session" ? auth.session.email : undefined), personOf: () => null,
  });
  const tool = createShareToolRoute({ host, localFolders: false, ...view, library, github, fetchTemplate, bots: () => [helper], routines: () => [], importDeps });
  const request = async (auth: RequestAuth, method: string, path: string, body?: unknown) => {
    let answer: { status: number; body: any } = { status: 0, body: null };
    const url = new URL(`http://127.0.0.1${path}`);
    const out = await routes({
      req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method, auth,
      json: ((_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }) as never,
      readBody: (async () => body) as never,
    });
    return out === PASS ? { status: 404, body: { error: "not routed" } } : answer;
  };
  const call = async (body: Record<string, unknown>, ctx: Partial<ShareToolContext> = {}) => {
    let answer: { status: number; body: any } = { status: 0, body: null };
    await tool({
      method: "POST", path: "/api/internal/share", res: {} as ServerResponse, readBody: async () => body, bot: helper, threadId: "thread-1",
      personMessage: "share yourself", roots: [], post: () => "message-1", actsForAdmin: true, githubPerson: null,
      json: ((_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }) as never, ...ctx,
    });
    return answer;
  };
  return { host, dataDir, request, call, made: () => host.export({ scope: "bot", bot: helper }, []) };
}

describe("a team's own templates", () => {
  it("an admin adds one under team-files/templates/<slug>/; adding again replaces it and keeps the old one as <slug>.previous/", async () => {
    const { request, made, dataDir } = setup();
    const card = made().card;
    const first = await request(ADMIN, "POST", `/api/share/${card.id}/library`);
    expect(first).toMatchObject({ status: 201, body: { replaced: false, template: { slug: "reporter", name: "Reporter", scope: "bot", addedBy: "olive@acme.test" } } });
    const root = teamTemplatesFolder(dataDir);
    expect(root).toBe(join(dataDir, "team-files", "templates"));
    expect(readFileSync(join(root, "reporter", "skills", "report", "scripts", "report.py"), "utf8")).toBe(SCRIPT);
    writeFileSync(join(root, "reporter", "marker.txt"), "first");
    const again = await request(ADMIN, "POST", `/api/share/${card.id}/library`);
    expect(again).toMatchObject({ status: 201, body: { replaced: true } });
    expect(existsSync(join(root, "reporter.previous", "marker.txt"))).toBe(true);
    expect(existsSync(join(root, "reporter", "marker.txt"))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["reporter", "reporter.previous"]);
    expect(JSON.stringify(readdirSync(join(root, "reporter"), { recursive: true }))).not.toMatch(/library|\.json/);
  });

  it("lists name, kind, who added it and when; imports from it through the folder reader; only an admin removes one", async () => {
    const { request, made } = setup();
    await request(ADMIN, "POST", `/api/share/${made().card.id}/library`);
    const listed = await request(ADMIN, "GET", "/api/share/library");
    expect(listed).toEqual({ status: 200, body: { team: "Acme", templates: [{ slug: "reporter", name: "Reporter", scope: "bot", tagline: "Weekly reports", addedBy: "olive@acme.test", addedAt: 1_700_000_000_000 }] } });
    const preview = await request(ADMIN, "POST", "/api/share/import?preview=1", { library: "reporter" });
    expect(preview).toMatchObject({ status: 200, body: { details: { scope: "bot", name: "Reporter", skills: [{ name: "report" }] } } });
    expect(await request(MEMBER, "DELETE", "/api/share/library/reporter")).toMatchObject({ status: 403 });
    expect(await request(MEMBER, "POST", `/api/share/${made().card.id}/library`)).toMatchObject({ status: 403 });
    expect(await request(ADMIN, "DELETE", "/api/share/library/reporter")).toEqual({ status: 200, body: { ok: true } });
    expect((await request(ADMIN, "GET", "/api/share/library")).body.templates).toEqual([]);
    expect(await request(ADMIN, "POST", "/api/share/import?preview=1", { library: "reporter" })).toMatchObject({ status: 404 });
    expect(await request(ADMIN, "DELETE", "/api/share/library/reporter")).toMatchObject({ status: 404 });
  });

  it("reads a library folder as untrusted: an edit that put a key in a script refuses the import", async () => {
    const { request, made, dataDir } = setup();
    await request(ADMIN, "POST", `/api/share/${made().card.id}/library`);
    writeFileSync(join(teamTemplatesFolder(dataDir), "reporter", "skills", "report", "scripts", "report.py"), `TOKEN = "${TOKEN}"\n`);
    const refused = await request(ADMIN, "POST", "/api/share/import?preview=1", { library: "reporter" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/looks like it holds a key or password/);
  });

  it("is a Team Cloud's alone, and takes only plain slugs", async () => {
    const { request, made } = setup({ team: false });
    expect(await request(ADMIN, "GET", "/api/share/library")).toMatchObject({ status: 404 });
    expect(await request(ADMIN, "POST", `/api/share/${made().card.id}/library`)).toMatchObject({ status: 404 });
    for (const library of ["../x", "Reporter", "a/b", "", 5]) expect(importSource({ library })).toBeTypeOf("string");
    expect(importSource({ library: "reporter" })).toEqual({ library: "reporter" });
    const templates = createTeamTemplates(scratch());
    expect(() => templates.add("../escape", {}, { name: "x", scope: "bot", tagline: "" })).toThrow();
  });
});

describe("the share tool and the team's templates", () => {
  it("adds, lists and imports for the team's owner or an admin only, in a request of their own", async () => {
    const { call } = setup();
    expect(await call({ action: "export" })).toMatchObject({ status: 200 });
    expect(await call({ action: "add_to_team_library" }, { actsForAdmin: false })).toMatchObject({ status: 403 });
    expect(await call({ action: "add_to_team_library" }, { personMessage: null })).toMatchObject({ status: 403 });
    expect(await call({ action: "add_to_team_library" }, { actingName: "Olive" })).toMatchObject({ status: 201, body: { text: expect.stringContaining("Added Reporter in Acme's templates") } });
    expect((await call({ action: "list_team_library" })).body.text).toContain("added by Olive");
    expect(await call({ action: "add_to_team_library" })).toMatchObject({ status: 201, body: { text: expect.stringContaining("Replaced") } });
    expect((await call({ action: "list_team_library" })).body.text).toMatch(/- reporter: Reporter \(a bot\), Weekly reports; added 2023-11-14/);
    expect(await call({ action: "list_team_library" }, { actsForAdmin: false })).toMatchObject({ status: 403 });
    expect(await call({ action: "import_from_team_library", slug: "nope" })).toMatchObject({ status: 404 });
    expect(await call({ action: "import_from_team_library", slug: "reporter" }, { actsForAdmin: false })).toMatchObject({ status: 403 });
  });

  it("says there is no library off a Team Cloud", async () => {
    const { call } = setup({ team: false });
    expect(await call({ action: "list_team_library" })).toMatchObject({ status: 404, body: { error: expect.stringContaining("Team Cloud") } });
  });
});

describe("GitHub through the connection", () => {
  const connected = (repo: ReturnType<typeof fakeGithubRepo>): GithubConnection => ({ ok: true, relay: repo.relay });

  it("parses owner/repo, folders and github.com links as plain names only", () => {
    expect(repoName("acme/playbooks")).toEqual({ owner: "acme", repo: "playbooks" });
    expect(repoName("https://github.com/acme/playbooks.git")).toEqual({ owner: "acme", repo: "playbooks" });
    for (const bad of ["acme", "acme/play/books", "../x/y", "acme/..", "-x/y"]) expect(repoName(bad), bad).toBeNull();
    expect(repoFolder(" templates/sales ")).toBe("templates/sales");
    expect(repoFolder(undefined)).toBe("");
    for (const bad of ["../x", "a/.git", "a/b/c/d/e/f/g"]) expect(repoFolder(bad), bad).toBeNull();
    expect(repoFolderOf("https://github.com/acme/playbooks/tree/main/templates/reporter")).toEqual({ owner: "acme", repo: "playbooks", ref: "main", path: "templates/reporter" });
    expect(repoFolderOf("https://github.com/acme/playbooks/blob/main/templates/reporter/bot.md")).toEqual({ owner: "acme", repo: "playbooks", ref: "main", path: "templates/reporter" });
    expect(repoFolderOf("https://github.com/acme/playbooks")).toEqual({ owner: "acme", repo: "playbooks", path: "" });
    for (const bad of ["http://github.com/a/b", "https://evil.test/a/b", "https://github.com/a/b/tree/main/a%2F..%2Fx", "https://u:p@github.com/a/b"]) expect(repoFolderOf(bad), bad).toBeNull();
  });

  it("opens a pull request in the person's repository with the scripts, then imports the private folder through the same connection", async () => {
    const repo = fakeGithubRepo({ owner: "acme", repo: "playbooks", push: true });
    const { request, made } = setup({ github: connected(repo) });
    const card = made().card;
    const published = await request(ADMIN, "POST", `/api/share/${card.id}/publish-repo`, { repo: "acme/playbooks", folder: "templates" });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ kind: "pull_request", url: "https://github.com/acme/playbooks/pull/1", branch: expect.stringMatching(/^mausbot-reporter-[a-f0-9]{6}$/) });
    expect(repo.pulls).toEqual([{ head: published.body.branch, base: "main", title: "Add the Reporter template from MausBot" }]);
    const branch = repo.branches.get(published.body.branch)!;
    expect([...branch.keys()].sort()).toEqual(["templates/reporter/bot.md", "templates/reporter/skills/report/SKILL.md", "templates/reporter/skills/report/scripts/report.py"]);
    expect(repo.branches.get("main")!.size).toBe(0);
    expect(JSON.stringify(repo.calls)).not.toMatch(/token|authorization|ghp_/i);
    const link = published.body.link as string;
    expect(link).toBe(`https://github.com/acme/playbooks/tree/${published.body.branch}/templates/reporter`);
    const preview = await request(ADMIN, "POST", "/api/share/import?preview=1", { url: link });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.details).toMatchObject({ name: "Reporter", skills: [{ name: "report" }] });
  });

  it("commits straight to the default branch when asked and allowed, and says so when the connection can't write", async () => {
    const repo = fakeGithubRepo({ owner: "acme", repo: "playbooks" });
    const { request, made } = setup({ github: connected(repo) });
    const card = made().card;
    const direct = await request(ADMIN, "POST", `/api/share/${card.id}/publish-repo`, { repo: "acme/playbooks", direct: true });
    expect(direct).toMatchObject({ status: 200, body: { kind: "commit", branch: "main", url: "https://github.com/acme/playbooks/tree/main/reporter" } });
    expect(repo.branches.get("main")!.has("reporter/skills/report/scripts/report.py")).toBe(true);
    const readOnly = fakeGithubRepo({ owner: "acme", repo: "playbooks", push: false });
    const refused = await setup({ github: connected(readOnly) });
    const answer = await refused.request(ADMIN, "POST", `/api/share/${refused.made().card.id}/publish-repo`, { repo: "acme/playbooks", direct: true });
    expect(answer).toMatchObject({ status: 403, body: { error: "Your GitHub connection can't write to acme/playbooks." } });
    expect(readOnly.calls.map((one) => one.slug)).toEqual(["GITHUB_GET_A_REPOSITORY"]);
  });

  it("never shows a pull request link outside the repository asked for", async () => {
    const repo = fakeGithubRepo({ owner: "acme", repo: "playbooks", pullUrl: "https://github.com/evil/elsewhere/pull/1" });
    const { request, made } = setup({ github: connected(repo) });
    const answer = await request(ADMIN, "POST", `/api/share/${made().card.id}/publish-repo`, { repo: "acme/playbooks" });
    expect(answer).toMatchObject({ status: 502, body: { error: "GitHub's answer for the pull request had no link." } });
  });

  it("without a GitHub connection: 'Connect GitHub in Apps first', and a private link's 404 says so", async () => {
    const { request, made } = setup();
    expect(await request(ADMIN, "GET", "/api/share/github")).toEqual({ status: 200, body: { connected: false, reason: "not_connected", error: CONNECT_GITHUB } });
    expect(await request(ADMIN, "POST", `/api/share/${made().card.id}/publish-repo`, { repo: "acme/playbooks" })).toMatchObject({ status: 409, body: { error: CONNECT_GITHUB, code: "github_not_connected" } });
    expect(await request(ADMIN, "POST", `/api/share/${made().card.id}/publish-repo`, { repo: "nope" })).toMatchObject({ status: 400 });
    const missing = await request(ADMIN, "POST", "/api/share/import?preview=1", { url: "https://github.com/acme/private/tree/main/reporter" });
    expect(missing).toMatchObject({ status: 404, body: { error: "Nothing was found at that GitHub link. If the repository is private, connect GitHub in Apps first." } });
  });

  it("reads a private folder only after the public read found nothing, with the same caps", async () => {
    const repo = fakeGithubRepo({ owner: "acme", repo: "private" });
    let publicReads = 0;
    const big = fakeGithubRepo({ owner: "acme", repo: "big" });
    big.put("main", "t/bot.md", `---\nbotmrr: 2\nname: Big\n---\n${"x".repeat(1_000_001)}`);
    const { request } = setup({ github: { ok: true, relay: async (...args) => (String(JSON.stringify(args[0])).includes("\"big\"") ? big : repo).relay(...args) },
      fetchTemplate: async () => { publicReads += 1; throw new GithubTemplateError("Nothing was found at that GitHub link.", 404); } });
    expect(await request(ADMIN, "POST", "/api/share/import?preview=1", { url: "https://github.com/acme/private/tree/main/none" })).toMatchObject({ status: 404, body: { error: "No bot.md or team.md was found in that folder." } });
    expect(publicReads).toBe(1);
    expect(await request(ADMIN, "POST", "/api/share/import?preview=1", { url: "https://github.com/acme/big/tree/main/t" })).toMatchObject({ status: 413 });
  });

  it("the share tool reads a private link through GitHub only for the team's admins", async () => {
    let asked = 0;
    const repo = fakeGithubRepo({ owner: "acme", repo: "private" });
    const { call } = setup({ github: { ok: true, relay: async (...args) => { asked += 1; return repo.relay(...args); } } });
    const link = "https://github.com/acme/private/tree/main/reporter";
    expect(await call({ action: "import", url: link }, { personMessage: `import ${link}`, actsForAdmin: false })).toMatchObject({ status: 404, body: { error: "Nothing was found at that GitHub link." } });
    expect(asked).toBe(0);
    expect(await call({ action: "import", url: link }, { personMessage: `import ${link}` })).toMatchObject({ status: 404, body: { error: "No bot.md or team.md was found in that folder." } });
    expect(asked).toBeGreaterThan(0);
  });

  it("the share tool publishes only to a repository the person named, for the team's admins", async () => {
    const repo = fakeGithubRepo({ owner: "acme", repo: "playbooks" });
    const { call } = setup({ github: connected(repo) });
    await call({ action: "export" });
    expect(await call({ action: "publish_to_repo", repo: "acme/playbooks" }, { personMessage: "publish yourself to our repo" })).toMatchObject({ status: 403 });
    expect(await call({ action: "publish_to_repo", repo: "acme/playbooks" }, { personMessage: "publish to acme/playbooks", actsForAdmin: false })).toMatchObject({ status: 403 });
    expect(repo.calls).toEqual([]);
    const done = await call({ action: "publish_to_repo", repo: "acme/playbooks", path: "bots" }, { personMessage: "publish to Acme/Playbooks please" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.text).toMatch(/^Opened a pull request in acme\/playbooks: https:\/\/github\.com\/acme\/playbooks\/pull\/1/);
    expect([...repo.branches.values()].some((files) => files.has("bots/reporter/bot.md"))).toBe(true);
  });
});

describe("which GitHub connection", () => {
  const composio = (apps: Record<string, { connected: boolean; accounts: Array<{ id: string; status: string }> }>, seen: unknown[] = []) => ({
    configured: () => true,
    connectedServices: async (_cfg: unknown, as?: unknown) => { seen.push(as ?? "team"); return apps as never; },
    relayMcp: async () => ({ status: 200, bytes: new Uint8Array(), contentType: "application/json" }),
  });

  it("is the team's, the person's own when each connects it, never one the Rules refuse", async () => {
    const seen: unknown[] = [];
    const github = { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }, { id: "ca_2", status: "ACTIVE" }] };
    const team = createShareGithubAccess({ cfg: () => ({}) as never, composio: composio({ github }, seen) as never, personApps: () => [], appsAccess: () => null, appRefusal: () => null });
    expect(await team(null)).toMatchObject({ ok: true, account: "ca_1" });
    expect(seen).toEqual(["team"]);
    const own = createShareGithubAccess({ cfg: () => ({}) as never, composio: composio({ github }) as never, personApps: () => ["github"], appsAccess: (person) => (person === "p_ada" ? { installationId: "i", token: "t" } as never : null), appRefusal: () => null });
    expect(await own(null)).toMatchObject({ ok: false, reason: "not_connected", message: CONNECT_GITHUB });
    expect(await own("p_ben")).toMatchObject({ ok: false, reason: "not_connected" });
    const refused = createShareGithubAccess({ cfg: () => ({}) as never, composio: composio({ github }) as never, personApps: () => [], appsAccess: () => null, appRefusal: () => "GitHub is off on this team." });
    expect(await refused(null)).toEqual({ ok: false, reason: "refused", message: "GitHub is off on this team." });
    const none = createShareGithubAccess({ cfg: () => ({}) as never, composio: composio({}) as never, personApps: () => [], appsAccess: () => null, appRefusal: () => null });
    expect(await none(null)).toMatchObject({ ok: false, reason: "not_connected" });
  });
});
