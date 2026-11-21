import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error the skill's helper is plain JavaScript with no types
import { apiBase, publish } from "../../skills/publish-to-netlify/deploy.mjs";
import { startFakeNetlify } from "../testing/fake-netlify.ts";
import { TEAM_READER, VaultStore } from "../vault-store.ts";
import { deleteNetlifySite, findNetlifySites, forgetSiteRecord, netlifyApiBase, parseSiteRecord, savedNetlifyToken, SCAN_LIMITS, SITE_FILE } from "./netlify-sites.ts";

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "published-apps-sites-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const RECORD = {
  version: 1, siteId: "3f2a6c1e-8a55-4b0c-9a50-1c2f6c1d9e11", name: "bright-bakery-4f2a1c", url: "https://bright-bakery-4f2a1c.netlify.app",
  adminUrl: "https://app.netlify.com/projects/bright-bakery-4f2a1c", title: "Bakery order page", botId: "bot_1a2b3c", botName: "Mira",
  createdAt: "2026-11-11T20:41:07.512Z", publishedAt: "2026-11-11T20:44:30.108Z", deployId: "6913a0c2e4b0a1000812f3aa", deployState: "ready", access: "public",
};
const put = (folder: string, record: unknown) => {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, SITE_FILE);
  writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record));
  return file;
};
const find = (roots: string[], home = "/nowhere/home") => findNetlifySites(roots, { home, env: {} });

describe("reading a site record", () => {
  it("takes the documented record as it is written", () => {
    expect(parseSiteRecord(JSON.stringify(RECORD), "/w/site/.netlify-site.json", 5, {})).toEqual({
      siteId: RECORD.siteId, file: "/w/site/.netlify-site.json", title: "Bakery order page", url: "https://bright-bakery-4f2a1c.netlify.app/",
      manageUrl: RECORD.adminUrl, publishedAt: Date.parse(RECORD.publishedAt), access: "public",
    });
  });

  it("reads a record from before version 1, and a private site as the Netlify team's", () => {
    const old = parseSiteRecord(JSON.stringify({ siteId: "abc", name: "old-site", url: "https://old-site.netlify.app", adminUrl: RECORD.adminUrl }), "f", 1234, {});
    expect(old).toMatchObject({ title: "old-site", publishedAt: 1234, access: "unknown" });
    expect(parseSiteRecord(JSON.stringify({ ...RECORD, access: "private", publishedAt: undefined }), "f", 1, {})).toMatchObject({ access: "netlify-team", publishedAt: Date.parse(RECORD.createdAt) });
  });

  it("refuses what is not a record, and an address a browser should not be sent to", () => {
    for (const bad of ["", "not json", "[]", "null", JSON.stringify({ url: RECORD.url }), JSON.stringify({ ...RECORD, siteId: "../../etc" }), JSON.stringify({ ...RECORD, siteId: 7 }),
      JSON.stringify({ ...RECORD, url: "javascript:alert(1)" }), JSON.stringify({ ...RECORD, url: "http://bright-bakery.netlify.app" }), JSON.stringify({ ...RECORD, url: "http://127.0.0.1:8080/" }),
      JSON.stringify({ ...RECORD, url: "https://user:pw@bright-bakery.netlify.app" }), JSON.stringify({ ...RECORD, url: "file:///etc/passwd" }), JSON.stringify({ ...RECORD, url: `https://a.test/${"x".repeat(3000)}` })]) {
      expect(parseSiteRecord(bad, "f", 1, {}), bad.slice(0, 60)).toBeNull();
    }
  });

  it("offers Manage on Netlify only for Netlify's own account pages", () => {
    for (const adminUrl of ["https://app.netlify.com.evil.test/projects/x", "https://evil.test/login", "http://app.netlify.com/projects/x", "javascript:alert(1)", 42]) {
      expect(parseSiteRecord(JSON.stringify({ ...RECORD, adminUrl }), "f", 1, {}), String(adminUrl)).not.toHaveProperty("manageUrl");
    }
  });

  it("keeps a title to one plain line, and ignores a field of the wrong kind", () => {
    expect(parseSiteRecord(JSON.stringify({ ...RECORD, title: "Bakery\n\u0007 order" }), "f", 1, {})?.title).toBe("Bakery order");
    expect(parseSiteRecord(JSON.stringify({ ...RECORD, title: { a: 1 }, publishedAt: "soon", createdAt: 5, access: ["public"] }), "f", 99, {}))
      .toMatchObject({ title: RECORD.name, publishedAt: 99, access: "unknown" });
  });

  it("accepts a loopback address only for the stand-in that replaces Netlify", () => {
    const env = { OMB_NETLIFY_API_URL: "http://127.0.0.1:4010/api/v1" };
    const record = JSON.stringify({ ...RECORD, url: "http://127.0.0.1:4010/live/abc/", adminUrl: "http://127.0.0.1:4010/admin/abc" });
    expect(parseSiteRecord(record, "f", 1, env)).toMatchObject({ url: "http://127.0.0.1:4010/live/abc/", manageUrl: "http://127.0.0.1:4010/admin/abc" });
    expect(parseSiteRecord(record, "f", 1, { OMB_NETLIFY_API_URL: "http://127.0.0.1:4011/api/v1" })).toBeNull();
    expect(parseSiteRecord(record, "f", 1, { OMB_NETLIFY_API_URL: "http://evil.test/api/v1" })).toBeNull();
  });
});

describe("finding site records in a bot's folders", () => {
  it("finds records at any depth up to the limit, one per site", async () => {
    const root = scratch();
    put(root, { ...RECORD, siteId: "top" });
    put(join(root, "projects", "bakery"), { ...RECORD, siteId: "nested" });
    put(join(root, "copy"), { ...RECORD, siteId: "nested" });
    put(join(root, "a", "b", "c", "d"), { ...RECORD, siteId: "deepest-allowed" });
    put(join(root, "a", "b", "c", "d", "e"), { ...RECORD, siteId: "too-deep" });
    expect((await find([root, root])).map((site) => site.siteId).sort()).toEqual(["deepest-allowed", "nested", "top"]);
  });

  it("skips hidden folders, installed packages, links, and records that are malformed or too big", async () => {
    const root = scratch(), elsewhere = scratch();
    put(join(root, ".git"), { ...RECORD, siteId: "hidden" });
    put(join(root, "node_modules", "pkg"), { ...RECORD, siteId: "package" });
    put(join(root, "broken"), "{ not json");
    put(join(root, "huge"), JSON.stringify({ ...RECORD, siteId: "huge", padding: "x".repeat(SCAN_LIMITS.recordBytes) }));
    const other = put(join(elsewhere, "theirs"), { ...RECORD, siteId: "someone-elses" });
    mkdirSync(join(root, "linked-file"));
    symlinkSync(other, join(root, "linked-file", SITE_FILE));
    symlinkSync(join(elsewhere, "theirs"), join(root, "linked-folder"));
    put(join(root, "good"), { ...RECORD, siteId: "good" });
    expect((await find([root])).map((site) => site.siteId)).toEqual(["good"]);
  });

  it("stops at its limits however many folders and records there are", async () => {
    const many = scratch(), wide = scratch();
    for (let at = 0; at < SCAN_LIMITS.sites + 20; at += 1) put(join(many, `site-${at}`), { ...RECORD, siteId: `site-${at}` });
    expect(await find([many])).toHaveLength(SCAN_LIMITS.sites);
    for (let at = 0; at < SCAN_LIMITS.folders + 50; at += 1) mkdirSync(join(wide, `folder-${String(at).padStart(4, "0")}`));
    put(join(wide, "zzz-last", "deep"), { ...RECORD, siteId: "past-the-limit" });
    expect(await find([wide])).toEqual([]);
  });

  it("never searches the person's home folder or anything above it, and survives a folder that is gone", async () => {
    const home = scratch();
    put(join(home, "Documents"), { ...RECORD, siteId: "in-home" });
    put(join(home, "data", "workspaces", "mira"), { ...RECORD, siteId: "in-workspace" });
    expect(await find([home, join(home, ".."), "/"], home)).toEqual([]);
    expect((await find([join(home, "data", "workspaces", "mira"), join(home, "missing")], home)).map((site) => site.siteId)).toEqual(["in-workspace"]);
  });
});

describe("deleting a site on Netlify", () => {
  const TOKEN = "nfp_published_apps_test_token_0123456789";

  it("uses the token the publish guide's card saved for that bot", () => {
    const vault = new VaultStore({ dataDir: scratch() });
    expect(savedNetlifyToken(vault, "mira", TEAM_READER, null)).toBeNull();
    vault.saveSecret({ name: "Netlify personal access token", value: TOKEN, source: "card", bots: ["mira"] });
    vault.saveSecret({ name: "Some other key", value: "other-value", source: "card", bots: "all" });
    expect(savedNetlifyToken(vault, "mira", TEAM_READER, null)).toBe(TOKEN);
    expect(savedNetlifyToken(vault, "another-bot", TEAM_READER, null)).toBeNull();
    expect(savedNetlifyToken(vault, "mira", null, null)).toBeNull();
    expect(readFileSync(new URL("../../skills/publish-to-netlify/SKILL.md", import.meta.url), "utf8")).toContain("label `Netlify personal access token`");
  });

  it("uses a member's own token only on that member's own click, and the team's shared one for a shared conversation", () => {
    const ADA = "p_adaadaadaadaadaadaada1", BEN = "p_benbenbenbenbenbenben1", ADAS = "nfp_adas_own_token_000000000000000000000";
    const vault = new VaultStore({ dataDir: scratch() });
    vault.saveSecret({ name: "Netlify personal access token", value: ADAS, source: "card", bots: ["mira"], person: ADA });
    const adasChat = { person: ADA, team: true }, bensChat = { person: BEN, team: true };
    expect(savedNetlifyToken(vault, "mira", adasChat, ADA)).toBe(ADAS);
    for (const [conversation, person] of [[adasChat, BEN], [adasChat, null], [bensChat, BEN], [TEAM_READER, ADA], [TEAM_READER, null], [bensChat, ADA]] as const) {
      expect(savedNetlifyToken(vault, "mira", conversation, person), JSON.stringify([conversation, person])).toBeNull();
    }
    vault.saveSecret({ name: "Netlify personal access token", value: TOKEN, source: "settings", bots: "all" });
    expect(savedNetlifyToken(vault, "mira", adasChat, ADA)).toBe(ADAS);
    for (const [conversation, person] of [[adasChat, BEN], [bensChat, BEN], [TEAM_READER, ADA], [TEAM_READER, null]] as const) {
      expect(savedNetlifyToken(vault, "mira", conversation, person), JSON.stringify([conversation, person])).toBe(TOKEN);
    }
  });

  it("uses the same API address guard as the publish helper", () => {
    for (const override of [undefined, "", "http://127.0.0.1:4010/api/v1", "http://127.0.0.1:4010/api/v1/", "http://127.0.0.1:4010", "https://127.0.0.1:4010/api/v1", "http://localhost:4010/api/v1",
      "http://127.0.0.1.evil.test/api/v1", "http://evil.test/api/v1", "http://127.0.0.1:4010/api/v1?x=@evil.test", "http://127.0.0.1:4010@evil.test/"]) {
      const env = override === undefined ? {} : { OMB_NETLIFY_API_URL: override };
      expect(netlifyApiBase(env), String(override)).toBe(apiBase(env));
    }
    expect(netlifyApiBase({ OMB_NETLIFY_API_URL: "http://evil.test/api/v1" })).toBe("https://api.netlify.com/api/v1");
  });

  it("sends one DELETE for that site to Netlify with the token, and nothing else", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response(null, { status: 204 }); });
    expect(await deleteNetlifySite("site-1", TOKEN, { env: {}, fetch: fetch as typeof globalThis.fetch })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.netlify.com/api/v1/sites/site-1");
    expect(calls[0]!.init).toMatchObject({ method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` }, redirect: "error" });
  });

  it("treats a site Netlify no longer has as deleted, and says why any other answer failed without the token", async () => {
    const answer = (status: number) => deleteNetlifySite("site-1", TOKEN, { env: {}, fetch: (async () => new Response(`denied ${TOKEN}`, { status })) as typeof fetch });
    expect(await answer(404)).toEqual({ ok: true });
    expect(await answer(401)).toEqual({ ok: false, reason: "token_refused", status: 401 });
    expect(await answer(403)).toEqual({ ok: false, reason: "token_refused", status: 403 });
    expect(await answer(500)).toEqual({ ok: false, reason: "failed", status: 500 });
    const thrown = await deleteNetlifySite("site-1", TOKEN, { env: {}, fetch: (async () => { throw new Error(`connect failed for Bearer ${TOKEN}`); }) as typeof fetch });
    expect(thrown).toEqual({ ok: false, reason: "failed", status: 0 });
    expect(JSON.stringify([await answer(401), await answer(500), thrown])).not.toContain(TOKEN);
  });

  it("deletes on the loopback stand-in, which refuses any other token", async () => {
    const fake = await startFakeNetlify(TOKEN);
    try {
      const env = { OMB_NETLIFY_API_URL: fake.url };
      const made = await (await fetch(`${fake.url}/sites`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" })).json() as { id: string };
      expect(await deleteNetlifySite(made.id, "wrong-token", { env })).toEqual({ ok: false, reason: "token_refused", status: 401 });
      expect(fake.sites.has(made.id)).toBe(true);
      expect(await deleteNetlifySite(made.id, TOKEN, { env })).toEqual({ ok: true });
      expect(fake.sites.has(made.id)).toBe(false);
      expect(await deleteNetlifySite(made.id, TOKEN, { env })).toEqual({ ok: true });
    } finally { await fake.stop(); }
  });

  it("does what the publish helper's own --delete does: the same call, a missing site counts as gone, the record goes", async () => {
    const fake = await startFakeNetlify(TOKEN);
    try {
      const env = { OMB_NETLIFY_API_URL: fake.url }, root = scratch(), tokenFile = join(scratch(), "token");
      writeFileSync(tokenFile, TOKEN);
      const made = async (name: string) => {
        const project = join(root, name);
        mkdirSync(join(project, "dist"), { recursive: true });
        writeFileSync(join(project, "dist", "index.html"), "<h1>hi</h1>");
        const result = await publish(["--dir", join(project, "dist"), "--project", project, "--token-file", tokenFile], env, { pollMs: 20 });
        return { project, siteId: result.siteId as string };
      };
      const byHelper = await made("helper"), byServer = await made("server");
      await publish(["--delete", "--project", byHelper.project, "--token-file", tokenFile], env, { pollMs: 20 });
      const [site] = await findNetlifySites([byServer.project], { home: "/nowhere/home", env });
      expect(site).toMatchObject({ siteId: byServer.siteId, file: join(byServer.project, SITE_FILE) });
      expect(await deleteNetlifySite(site!.siteId, TOKEN, { env })).toEqual({ ok: true });
      expect(await forgetSiteRecord(site!, [root], env)).toBe(true);
      expect(fake.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /api/v1/sites/${byHelper.siteId}`, `DELETE /api/v1/sites/${byServer.siteId}`]);
      expect([existsSync(join(byHelper.project, SITE_FILE)), existsSync(join(byServer.project, SITE_FILE)), fake.sites.size]).toEqual([false, false, 0]);

      const again = await made("again");
      fake.sites.delete(again.siteId);
      expect(await publish(["--delete", "--project", again.project, "--token-file", tokenFile], env, { pollMs: 20 })).toMatchObject({ deleted: true, alreadyGone: true });
      expect(await deleteNetlifySite(again.siteId, TOKEN, { env })).toEqual({ ok: true });
      expect(fake.refused).toEqual([]);
    } finally { await fake.stop(); }
  });

  it("removes the record of the deleted site only, and only inside the bot's folders", async () => {
    const root = scratch(), outside = scratch();
    const file = put(join(root, "site"), RECORD), far = put(join(outside, "site"), RECORD);
    expect(await forgetSiteRecord({ file: far, siteId: RECORD.siteId }, [root], {})).toBe(false);
    expect(await forgetSiteRecord({ file, siteId: "another-site" }, [root], {})).toBe(false);
    expect(existsSync(file) && existsSync(far)).toBe(true);
    expect(await forgetSiteRecord({ file, siteId: RECORD.siteId }, [root], {})).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(readFileSync(far, "utf8")).siteId).toBe(RECORD.siteId);
  });
});
