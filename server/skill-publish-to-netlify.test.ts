import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PAGE_MAX_BYTES, PAGE_MAX_FILES } from "../shared/published-page.ts";
import { parseSkillMd, scanSkillText } from "../shared/skill-md.ts";
import { DEFAULT_HOSTING_LIMITS } from "./host/included-hosting.ts";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";
import { startFakeNetlify, type FakeNetlify } from "./testing/fake-netlify.ts";

const SKILL_DIR = join(process.cwd(), "skills", "publish-to-netlify");
const HELPER = join(SKILL_DIR, "deploy.mjs");

interface Helper {
  SITE_FILE: string;
  publishable(path: string): boolean;
  collectFiles(dir: string): { files: Array<{ path: string; full: string; size: number }>; skipped: string[] };
  buildDigest(files: Array<{ path: string; full: string }>): { digest: Record<string, string>; bySha: Map<string, { path: string }> };
  uploadPath(path: string): string;
  apiBase(env: Record<string, string | undefined>): string;
  proxyFor(url: URL, env: Record<string, string | undefined>): URL | null;
  openTunnel(proxy: URL, host: string, port: number): Promise<Socket>;
  publish(argv: string[], env: Record<string, string | undefined>, options?: { pollMs?: number; waitMs?: number; linkWaitMs?: number; privateAfterMs?: number; now?: () => Date }): Promise<Record<string, unknown>>;
}
const helper = await import(pathToFileURL(HELPER).href) as Helper;

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

describe("publish-to-netlify skill guide", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const skill = skills.find((entry) => entry.manifest.id === "publish-to-netlify");
  const guide = skill?.instructions ?? "";
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((entry) => entry.manifest.id);

  it("is a valid skill that the scanner has nothing to say about", () => {
    expect(skill?.manifest.defaultEnabled).toBe(true);
    const parsed = parseSkillMd(guide);
    expect(parsed).toMatchObject({ name: "publish-to-netlify" });
    expect(scanSkillText(guide)).toEqual([]);
    expect(scanSkillText(readFileSync(HELPER, "utf8"))).toEqual([]);
    expect(readdirSync(SKILL_DIR).sort()).toEqual(["SKILL.md", "deploy.mjs", "manifest.json", "site-record.md"]);
  });

  it("mounts when a bot is asked to put a site or app online, and not for a page or a report", () => {
    for (const text of ["Deploy this to Netlify", "build me a todo web app and deploy it", "make a website for my bakery", "publish the site so customers can see it",
      "turn this into a live app", "can you host it somewhere?"]) {
      expect(ids(text), text).toContain("publish-to-netlify");
    }
    for (const text of ["summarise this report", "make a dashboard of last month's sales", "check the competitor's website for prices", "publish this page", "what's on my calendar",
      "deploy the API to Fly", "redeploy the worker and check the deployment logs"]) {
      expect(ids(text), text).not.toContain("publish-to-netlify");
    }
  });

  it("states the rules a bot must keep, with the real tool names and limits", () => {
    expect(guide.split("\n").length).toBeLessThanOrEqual(185);
    for (const tool of ["request_credential", "publish_page", "show_html", "select_computer", "copy_to_computer", "copy_from_computer", "exec_status"]) expect(guide, tool).toContain(tool);
    expect(guide).toContain(`up to ${PAGE_MAX_BYTES / 1024 / 1024} MB and ${PAGE_MAX_FILES} files`);
    expect(guide).toContain("https://app.netlify.com/user/applications#personal-access-tokens");
    expect(guide).toContain("deploy.mjs");
    expect(guide).toContain(helper.SITE_FILE);
    expect(guide).toMatch(/link is public/);
    expect(guide).toMatch(/no sign-in for visitors/);
    expect(guide).toMatch(/token never goes to the cloud computer/);
    expect(guide).toContain('"access": "private"');
    expect(guide).toContain("contentType");
    expect(guide).toContain('"pending": true');
    expect(guide).toMatch(/--check --token-file/);
    expect(guide).toMatch(/don't report a dead link or a failure/);
    expect(guide).toMatch(/--delete --token-file/);
    expect(guide).toMatch(/only after they confirm/);
    expect(guide).toMatch(/link will stop working for everyone/);
    expect(guide).toMatch(/--make-public[^.]*only after they say/);
    expect(guide).toMatch(/Early Access/);
    expect(guide).toMatch(/Never promise that it is always on/);
  });

  it("puts the plan's included hosting first, and says when the person's own Netlify account is the way", () => {
    for (const tool of ["publish_app", "check_app_hosting"]) expect(guide, tool).toContain(tool);
    const included = guide.slice(guide.indexOf("## Included hosting first"), guide.indexOf("## The token, once"));
    expect(included).toMatch(/use it first/);
    expect(included).toMatch(/no token card/);
    expect(included).toMatch(/needs no Netlify account/);
    expect(included).toContain(`up to ${DEFAULT_HOSTING_LIMITS.maxBytes / 1024 / 1024} MB and ${DEFAULT_HOSTING_LIMITS.maxFiles} files an app, ${DEFAULT_HOSTING_LIMITS.maxFileBytes / 1024 / 1024} MB a file`);
    expect(included).toMatch(/how many of the plan's apps are in use \("3 of 10"\)/);
    expect(included).toMatch(/public at once/);
    expect(included).toMatch(/show_html/);
    expect(included).toMatch(/Publish only when they say yes/);
    expect(included).toMatch(/plan's apps or this month's publishes are used up/);
    expect(included).toMatch(/with the numbers it gave, and offer their own account/);
    expect(included).toMatch(/functions, a database, a server, redirects, or more than its sizes/);
    expect(included).toMatch(/already has a site on their account \(keep its link\)/);
  });
});

describe("publish-to-netlify helper: what may be uploaded", () => {
  it("keeps secrets, dotfiles, env files, keys and dependencies out", () => {
    for (const path of ["index.html", "assets/app.js", "img/logo.png", "_redirects", "_headers", ".well-known/security.txt", "docs/environment.html", "env.js", "keyboard.js", "data/monkey.json"]) {
      expect(helper.publishable(path), path).toBe(true);
    }
    for (const path of [".env", ".env.production", "app/.env.local", "prod.env", "env", "env.local", ".openmausbot-secrets/t1/card", ".git/config", ".netlify-site.json", ".netlify/state.json",
      ".DS_Store", "node_modules/x/index.js", "site/node_modules/x.js", "server.pem", "tls/private.key", "cert.p12", "id_rsa", "id_ed25519.pub", "credentials.json", "secrets.yaml",
      "service-account.prod.json", "what?.html", "a#b.html", "__MACOSX/x", "Thumbs.db", ""]) {
      expect(helper.publishable(path), path).toBe(false);
    }
  });

  it("walks a folder without following links, and builds Netlify's digest", () => {
    const root = mkdtempSync(join(tmpdir(), "netlify-skill-digest-"));
    try {
      const site = join(root, "site");
      mkdirSync(join(site, "assets"), { recursive: true });
      mkdirSync(join(site, ".openmausbot-secrets", "t1"), { recursive: true });
      writeFileSync(join(site, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(site, "assets", "a b.css"), "body{}");
      writeFileSync(join(site, "assets", "copy.css"), "body{}");
      writeFileSync(join(site, ".env"), "KEY=1");
      writeFileSync(join(site, ".openmausbot-secrets", "t1", "card"), "nfp_secret");
      writeFileSync(join(root, "outside.txt"), "private");
      symlinkSync(join(root, "outside.txt"), join(site, "linked.txt"));
      symlinkSync(root, join(site, "up"));

      const { files, skipped } = helper.collectFiles(site);
      expect(files.map((file) => file.path)).toEqual(["assets/a b.css", "assets/copy.css", "index.html"]);
      expect(skipped.sort()).toEqual([".env", ".openmausbot-secrets", "linked.txt", "up"]);
      const { digest, bySha } = helper.buildDigest(files);
      expect(digest).toEqual({ "/assets/a b.css": sha1("body{}"), "/assets/copy.css": sha1("body{}"), "/index.html": sha1("<h1>hi</h1>") });
      expect(bySha.get(sha1("body{}"))?.path).toBe("assets/a b.css");
      expect(helper.uploadPath("assets/a b.css")).toBe("assets/a%20b.css");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sends the token to Netlify or a loopback stand-in only", () => {
    expect(helper.apiBase({})).toBe("https://api.netlify.com/api/v1");
    expect(helper.apiBase({ OMB_NETLIFY_API_URL: "http://127.0.0.1:4010/api/v1" })).toBe("http://127.0.0.1:4010/api/v1");
    for (const elsewhere of ["https://evil.example/api/v1", "http://127.0.0.1.evil.example:80/", "http://localhost:4010", "http://10.0.0.5:4010", "http://127.0.0.1:4010@evil.example/"]) {
      expect(helper.apiBase({ OMB_NETLIFY_API_URL: elsewhere }), elsewhere).toBe("https://api.netlify.com/api/v1");
    }
  });

  it("uses the commands' own proxy for https, and honours NO_PROXY", () => {
    const api = new URL("https://api.netlify.com/api/v1/sites");
    expect(helper.proxyFor(api, {})).toBeNull();
    expect(helper.proxyFor(api, { HTTPS_PROXY: "http://127.0.0.1:3128" })?.host).toBe("127.0.0.1:3128");
    expect(helper.proxyFor(api, { http_proxy: "http://127.0.0.1:3128" })?.host).toBe("127.0.0.1:3128");
    expect(helper.proxyFor(api, { HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: "localhost,.netlify.com" })).toBeNull();
    expect(helper.proxyFor(new URL("http://127.0.0.1:4010/api/v1"), { HTTPS_PROXY: "http://127.0.0.1:3128" })).toBeNull();
  });

  it("opens a CONNECT tunnel through a proxy, and reports a refusal", async () => {
    const echo = createTcpServer((socket) => socket.on("data", (chunk) => socket.write(`echo:${chunk}`)));
    await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done));
    const echoPort = (echo.address() as AddressInfo).port;
    const asked: string[] = [];
    const proxy = createHttpServer();
    proxy.on("connect", (req, client) => {
      asked.push(req.url ?? "");
      if (req.url !== `allowed.example:${echoPort}`) return client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      const upstream = connect(echoPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const proxyUrl = new URL(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    try {
      const socket = await helper.openTunnel(proxyUrl, "allowed.example", echoPort);
      const answer = new Promise<string>((done) => socket.once("data", (chunk) => done(chunk.toString())));
      socket.write("ping");
      expect(await answer).toBe("echo:ping");
      socket.destroy();
      await expect(helper.openTunnel(proxyUrl, "refused.example", 443)).rejects.toThrow(/proxy refused the connection to refused\.example \(403\)/);
      expect(asked).toEqual([`allowed.example:${echoPort}`, "refused.example:443"]);
    } finally {
      proxy.closeAllConnections();
      proxy.close();
      echo.close();
    }
  });
});

describe("publish-to-netlify helper, end to end against a stand-in on loopback", () => {
  const TOKEN = "nfp_FixtureTokenNeverReal0123456789abcdef";
  let fake: FakeNetlify;
  let home: string;
  let project: string;
  let tokenFile: string;

  const run = (args: string[], env: Record<string, string> = {}, cwd = project) => new Promise<{ code: number; stdout: string; stderr: string; json: Record<string, unknown> }>((done) => {
    execFile(process.execPath, [HELPER, ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: home, OMB_NETLIFY_API_URL: fake.url, ...env } }, (error, stdout, stderr) => {
      done({ code: error ? Number(error.code) : 0, stdout, stderr, json: JSON.parse(stdout.trim() || "{}") as Record<string, unknown> });
    });
  });
  const filesHoldingToken = (folder: string): string[] => readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes(TOKEN))
    .map((entry) => join(entry.parentPath, entry.name));

  beforeAll(async () => {
    fake = await startFakeNetlify(TOKEN);
    home = mkdtempSync(join(tmpdir(), "netlify-skill-home-"));
    project = join(home, "workspace", "bakery");
    mkdirSync(join(project, "dist", "assets"), { recursive: true });
    mkdirSync(join(project, ".openmausbot-secrets", "thread1"), { recursive: true, mode: 0o700 });
    tokenFile = join(project, ".openmausbot-secrets", "thread1", "card1");
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(project, "dist", "index.html"), "<h1>Bakery</h1>");
    writeFileSync(join(project, "dist", "assets", "app.js"), "console.log('v1')");
    writeFileSync(join(project, "dist", ".env"), "STRIPE=sk_live_never");
    writeFileSync(join(project, "dist", "server.pem"), "-----BEGIN PRIVATE KEY-----");
    mkdirSync(join(project, "dist", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(project, "dist", "node_modules", "dep", "index.js"), "module.exports = 1");
  });
  afterAll(async () => {
    await fake.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a site on the first publish, uploads only what may go out, and confirms the link answers", async () => {
    const first = await run(["--dir", "dist", "--token-file", tokenFile]);
    expect(first.stderr).toBe("");
    expect(first.json).toMatchObject({ ok: true, created: true, state: "ready", live: true, access: "public", liveStatus: 200, files: 2, uploaded: 2 });
    expect([...fake.uploads].sort()).toEqual(["/assets/app.js", "/index.html"]);
    expect(first.json.skipped).toEqual([".env", "node_modules", "server.pem"]);

    const record = JSON.parse(readFileSync(join(project, helper.SITE_FILE), "utf8")) as Record<string, string>;
    expect(Object.keys(record)).toEqual(["version", "siteId", "name", "url", "adminUrl", "title", "createdAt", "publishedAt", "deployId", "deployState", "access"]);
    expect(record).toMatchObject({ version: 1, title: record.name, deployId: first.json.deployId, deployState: "ready", access: "public" });
    expect(record.siteId).toBe(first.json.siteId);
    expect(await (await fetch(String(first.json.url))).text()).toBe("<h1>Bakery</h1>");
    expect((await fetch(`${first.json.url}.env`)).status).toBe(404);
  });

  it("publishes a change to the same site and link, uploading only the changed file", async () => {
    const before = JSON.parse(readFileSync(join(project, helper.SITE_FILE), "utf8")) as Record<string, string>;
    const uploadsBefore = fake.uploads.length;
    writeFileSync(join(project, "dist", "assets", "app.js"), "console.log('v2')");
    const second = await run(["--dir", "dist", "--token-file", tokenFile]);
    expect(second.json).toMatchObject({ ok: true, created: false, siteId: before.siteId, url: before.url, live: true, files: 2, uploaded: 1 });
    expect(fake.uploads.slice(uploadsBefore)).toEqual(["/assets/app.js"]);
    expect(fake.requests.filter((request) => request === "POST /api/v1/sites")).toHaveLength(1);
    expect([...fake.sites.keys()]).toEqual([before.siteId]);
    expect(await (await fetch(`${before.url}assets/app.js`)).text()).toBe("console.log('v2')");
  });

  it("publishes a draft beside the live site without changing it", async () => {
    writeFileSync(join(project, "dist", "index.html"), "<h1>Bakery, draft</h1>");
    const draft = await run(["--dir", "dist", "--token-file", tokenFile, "--draft"]);
    const record = JSON.parse(readFileSync(join(project, helper.SITE_FILE), "utf8")) as Record<string, string>;
    expect(draft.json).toMatchObject({ ok: true, draft: true, live: true });
    expect(draft.json.url).not.toBe(record.url);
    expect(await (await fetch(String(draft.json.url))).text()).toBe("<h1>Bakery, draft</h1>");
    expect(await (await fetch(record.url!)).text()).toBe("<h1>Bakery</h1>");
    writeFileSync(join(project, "dist", "index.html"), "<h1>Bakery</h1>");
  });

  it("keeps the token in its secret file only: not in output, the site record, the home folder or what was uploaded", async () => {
    const again = await run(["--dir", "dist", "--token-file", tokenFile]);
    expect(again.stdout + again.stderr).not.toContain(TOKEN);
    expect(filesHoldingToken(home)).toEqual([tokenFile]);
    for (const site of fake.sites.values()) for (const bytes of site.live.values()) expect(bytes.includes(TOKEN)).toBe(false);
    expect(fake.refused).toEqual([]);
  });

  it("refuses to publish a file that contains the token, or a folder that holds the token file", async () => {
    const requestsBefore = fake.requests.length;
    writeFileSync(join(project, "dist", "config.js"), `const key = "${TOKEN}"`);
    const leaking = await run(["--dir", "dist", "--token-file", tokenFile]);
    rmSync(join(project, "dist", "config.js"));
    expect(leaking).toMatchObject({ code: 1, json: { ok: false, error: "config.js contains the Netlify token; remove it before publishing" } });

    const whole = await run(["--dir", ".", "--token-file", tokenFile]);
    expect(whole).toMatchObject({ code: 1, json: { ok: false } });
    expect(String(whole.json.error)).toMatch(/token file is inside the folder to publish/);
    expect(fake.requests.length).toBe(requestsBefore);
  });

  it("says plainly what Netlify answered, without the token", async () => {
    const wrong = join(project, ".openmausbot-secrets", "thread1", "card2");
    writeFileSync(wrong, "nfp_RevokedTokenNeverReal", { mode: 0o600 });
    const denied = await run(["--dir", "dist", "--token-file", wrong]);
    expect(denied).toMatchObject({ code: 1, json: { ok: false, error: "Starting the deploy: Netlify answered 401: Access Denied" } });
    expect(denied.stdout).not.toContain("nfp_Revoked");
    rmSync(wrong);

    fake.failNext(429, { code: 429, message: "Too many deploys" });
    const limited = await run(["--dir", "dist", "--token-file", tokenFile]);
    expect(limited.json).toMatchObject({ ok: false, error: "Starting the deploy: Netlify answered 429: Too many deploys" });

    const elsewhere = join(home, "workspace", "taken");
    mkdirSync(elsewhere, { recursive: true });
    fake.failNext(422, { errors: { subdomain: ["must be unique"] } });
    const taken = await run(["--dir", join(project, "dist"), "--token-file", tokenFile, "--project", elsewhere, "--name", "bakery"]);
    expect(taken.json).toMatchObject({ ok: false, error: 'Creating the site: Netlify answered 422: {"subdomain":["must be unique"]}' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("does not make a second site when the recorded one is gone, and never ignores a broken record", async () => {
    const elsewhere = join(home, "workspace", "gone");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, helper.SITE_FILE), JSON.stringify({ siteId: "deleted-site", url: "https://gone.netlify.app" }));
    const gone = await run(["--dir", join(project, "dist"), "--token-file", tokenFile, "--project", elsewhere]);
    expect(gone.json).toMatchObject({ ok: false, error: "Starting the deploy: Netlify answered 404: Not Found" });

    writeFileSync(join(elsewhere, helper.SITE_FILE), JSON.stringify({ url: "https://gone.netlify.app" }));
    const broken = await run(["--dir", join(project, "dist"), "--token-file", tokenFile, "--project", elsewhere]);
    expect(String(broken.json.error)).toMatch(/has no valid siteId/);
    expect(fake.requests.filter((request) => request === "POST /api/v1/sites")).toHaveLength(2);
  });

  it("leaves a project whose app is on the plan's included hosting alone: no deploy, check, change or delete", async () => {
    const included = join(home, "workspace", "included");
    mkdirSync(included, { recursive: true });
    const record = JSON.stringify({ version: 1, hosting: "included", appKey: "app-5d0c1b7e9a3f4c62b8e1d2a4f6c80913", siteId: "app-5d0c1b7e9a3f4c62b8e1d2a4f6c80913", url: "https://mb-3f9c2a17d04e8b65.netlify.app/" });
    writeFileSync(join(included, helper.SITE_FILE), record);
    const before = fake.requests.length;
    for (const args of [["--dir", join(project, "dist")], ["--check"], ["--make-public"], ["--delete"]]) {
      const answer = await run([...args, "--token-file", tokenFile, "--project", included]);
      expect(answer.json, args[0]).toEqual({ ok: false, error: "this project's app is on the Cloud plan's included hosting (https://mb-3f9c2a17d04e8b65.netlify.app/), not on Netlify; "
        + "update or delete it with publish_app, or publish to Netlify from another project folder (--project)" });
    }
    expect(fake.requests).toHaveLength(before);
    expect(readFileSync(join(included, helper.SITE_FILE), "utf8")).toBe(record);
  });

  it("reports a new account's site as deployed but private, and opens it only when asked to", async () => {
    const guarded = await startFakeNetlify(TOKEN, { teamLogin: true });
    const elsewhere = join(home, "workspace", "guarded");
    mkdirSync(elsewhere, { recursive: true });
    const args = ["--token-file", tokenFile, "--project", elsewhere];
    try {
      const first = await run(["--dir", join(project, "dist"), ...args], { OMB_NETLIFY_API_URL: guarded.url });
      expect(first).toMatchObject({ code: 0, json: { ok: true, created: true, state: "ready", live: false, access: "private", liveStatus: 401 } });
      expect(guarded.requests.some((request) => request.startsWith("PATCH "))).toBe(false);
      expect((await fetch(String(first.json.url))).status).toBe(401);

      const opened = await run(["--make-public", ...args], { OMB_NETLIFY_API_URL: guarded.url });
      expect(opened.json).toMatchObject({ ok: true, live: true, access: "public", siteId: first.json.siteId, url: first.json.url });
      expect(guarded.requests.filter((request) => request.startsWith("PATCH "))).toEqual([`PATCH /api/v1/sites/${String(first.json.siteId)}`]);
      expect(guarded.requests.filter((request) => /^POST .*\/deploys$/.test(request))).toHaveLength(1);
      expect(await (await fetch(String(first.json.url))).text()).toBe("<h1>Bakery</h1>");

      const nothing = await run(["--make-public", "--token-file", tokenFile, "--project", join(home, "workspace")], { OMB_NETLIFY_API_URL: guarded.url });
      expect(String(nothing.json.error)).toMatch(/\.netlify-site\.json is missing; publish the site first/);
    } finally {
      await guarded.stop();
    }
  });

  it("publishes a one-file site under its own name, and does not call a root served as plain text live", async () => {
    const single = join(home, "workspace", "single");
    mkdirSync(join(single, "out"), { recursive: true });
    writeFileSync(join(single, "out", "index.html"), "<h1>One file</h1>");
    const deploysBefore = fake.deploys.size;
    const first = await run(["--dir", "out", "--token-file", tokenFile, "--project", single], {}, single);
    expect(first.json).toMatchObject({ ok: true, live: true, files: 1, uploaded: 1, contentType: "text/html; charset=UTF-8" });
    const sent = [...fake.deploys.values()].slice(deploysBefore).map((deploy) => deploy.files);
    expect(sent).toEqual([{ "/index.html": sha1("<h1>One file</h1>") }]);
    expect(fake.uploads.at(-1)).toBe("/index.html");

    fake.rootContentType = "text/plain; charset=UTF-8";
    const plain = await run(["--dir", "out", "--token-file", tokenFile, "--project", single], {}, single);
    fake.rootContentType = "text/html; charset=UTF-8";
    expect(plain.json).toMatchObject({ ok: true, state: "ready", live: false, access: "public", liveStatus: 200, contentType: "text/plain; charset=UTF-8" });
  });

  describe("a new site's slow first deploy", () => {
    const quick = { pollMs: 5, waitMs: 150, linkWaitMs: 150, privateAfterMs: 20 };
    const readRecord = (folder: string) => JSON.parse(readFileSync(join(folder, helper.SITE_FILE), "utf8")) as Record<string, string>;
    const startIn = (name: string) => {
      const folder = join(home, "workspace", name);
      mkdirSync(join(folder, "out"), { recursive: true });
      writeFileSync(join(folder, "out", "index.html"), `<h1>${name}</h1>`);
      return { folder, argv: ["--dir", join(folder, "out"), "--token-file", tokenFile, "--project", folder] };
    };

    it("keeps waiting while Netlify is processing, then checks the link", async () => {
      const { folder, argv } = startIn("slow");
      fake.processingPolls = 6;
      try {
        const result = await helper.publish([...argv, "--title", "Slow  site\nfor a bakery", "--bot-name", "Mira"], { OMB_NETLIFY_API_URL: fake.url, OMB_BOT_ID: "bot_1a2b" }, { ...quick, now: () => new Date("2026-11-11T20:44:30.000Z") });
        expect(result).toMatchObject({ ok: true, created: true, state: "ready", live: true, access: "public", liveStatus: 200, uploaded: 1, alreadyOnNetlify: 0 });
        expect(result).not.toHaveProperty("pending");
        expect(fake.requests.filter((request) => request === `GET /api/v1/sites/${String(result.siteId)}/deploys/${String(result.deployId)}`)).toHaveLength(6);
        expect(readRecord(folder)).toMatchObject({ version: 1, title: "Slow site for a bakery", botName: "Mira", botId: "bot_1a2b", createdAt: "2026-11-11T20:44:30.000Z",
          publishedAt: "2026-11-11T20:44:30.000Z", deployState: "ready", access: "public" });
      } finally {
        fake.processingPolls = 0;
      }
    });

    it("says a deploy is still being processed, without calling it live or failed, and picks it up with --check", async () => {
      const { folder, argv } = startIn("slower");
      fake.processingPolls = 1_000_000;
      let pending: Record<string, unknown>;
      try {
        pending = await helper.publish(argv, { OMB_NETLIFY_API_URL: fake.url }, quick);
      } finally {
        fake.processingPolls = 0;
      }
      expect(pending).toMatchObject({ ok: true, pending: true, state: "processing", live: false });
      expect(String(pending.message)).toMatch(/still processing this deploy \(processing\)\. It is not live yet and has not failed\. Run again with --check/);
      expect(pending).not.toHaveProperty("access");
      expect(pending).not.toHaveProperty("liveStatus");
      expect(readRecord(folder)).toMatchObject({ deployId: pending.deployId, deployState: "processing" });
      expect(readRecord(folder)).not.toHaveProperty("publishedAt");

      const still = await helper.publish(["--check", "--token-file", tokenFile, "--project", folder], { OMB_NETLIFY_API_URL: fake.url }, quick);
      expect(still).toMatchObject({ ok: true, pending: true, state: "processing", deployId: pending.deployId });

      fake.deploys.get(String(pending.deployId))!.pollsLeft = 1;
      const deploysBefore = fake.deploys.size;
      const done = await helper.publish(["--check", "--token-file", tokenFile, "--project", folder], { OMB_NETLIFY_API_URL: fake.url }, { ...quick, now: () => new Date("2026-11-11T21:00:00.000Z") });
      expect(done).toMatchObject({ ok: true, state: "ready", live: true, access: "public", deployId: pending.deployId, url: pending.url });
      expect(done).not.toHaveProperty("pending");
      expect(fake.deploys.size).toBe(deploysBefore);
      expect(readRecord(folder)).toMatchObject({ deployState: "ready", publishedAt: "2026-11-11T21:00:00.000Z", access: "public" });

      const again = await helper.publish(["--check", "--token-file", tokenFile, "--project", folder], { OMB_NETLIFY_API_URL: fake.url }, quick);
      expect(again).toMatchObject({ state: "ready", live: true });
      expect(readRecord(folder).publishedAt).toBe("2026-11-11T21:00:00.000Z");
    });

    it("always says public or private once a deploy is ready, and counts files Netlify already holds", async () => {
      const { folder, argv } = startIn("counted");
      writeFileSync(join(folder, "out", "app.js"), "console.log('v2')");
      writeFileSync(join(folder, "out", "style.css"), "h1{color:teal}");
      const first = await helper.publish(argv, { OMB_NETLIFY_API_URL: fake.url }, quick);
      expect(first).toMatchObject({ state: "ready", live: true, access: "public", files: 3, uploaded: 2, alreadyOnNetlify: 1 });
      const before = readRecord(folder);

      fake.rootContentType = "text/plain";
      const plain = await helper.publish(argv, { OMB_NETLIFY_API_URL: fake.url }, quick);
      fake.rootContentType = "text/html; charset=UTF-8";
      expect(plain).toMatchObject({ state: "ready", live: false, access: "public", uploaded: 0, alreadyOnNetlify: 3 });
      expect(readRecord(folder)).toMatchObject({ siteId: before.siteId, url: before.url, title: before.title, createdAt: before.createdAt });
    });
  });

  describe("deleting a published site", () => {
    const publishIn = async (name: string) => {
      const folder = join(home, "workspace", name);
      mkdirSync(join(folder, "out"), { recursive: true });
      writeFileSync(join(folder, "out", "index.html"), `<h1>${name}</h1>`);
      const published = await run(["--dir", "out", "--token-file", tokenFile], {}, folder);
      expect(published.json).toMatchObject({ ok: true, live: true });
      return { folder, siteId: String(published.json.siteId), url: String(published.json.url) };
    };

    it("deletes the site from Netlify, then its record, and leaves the files", async () => {
      const { folder, siteId, url } = await publishIn("to-delete");
      const deleted = await run(["--delete", "--token-file", tokenFile], {}, folder);
      expect(deleted).toMatchObject({ code: 0, json: { ok: true, deleted: true, alreadyGone: false, siteId, url } });
      expect(String(deleted.json.message)).toMatch(/deleted from Netlify and its link no longer works/);
      expect(fake.requests.at(-1)).toBe(`DELETE /api/v1/sites/${siteId}`);
      expect(fake.sites.has(siteId)).toBe(false);
      expect((await fetch(url)).status).toBe(404);
      expect(readdirSync(folder)).toEqual(["out"]);

      const none = await run(["--delete", "--token-file", tokenFile], {}, folder);
      expect(none.code).toBe(1);
      expect(String(none.json.error)).toMatch(/no published site recorded in this folder/);
      expect(fake.requests.filter((request) => request.startsWith("DELETE "))).toEqual([`DELETE /api/v1/sites/${siteId}`]);
    });

    it("treats a site Netlify no longer has as already deleted", async () => {
      const { folder, siteId } = await publishIn("already-gone");
      fake.sites.delete(siteId);
      const deleted = await run(["--delete", "--token-file", tokenFile], {}, folder);
      expect(deleted).toMatchObject({ code: 0, json: { ok: true, deleted: true, alreadyGone: true, siteId } });
      expect(readdirSync(folder)).toEqual(["out"]);
    });

    it("keeps the site and its record when Netlify refuses the token, and deletes nothing else", async () => {
      const { folder, siteId } = await publishIn("kept");
      const wrong = join(project, ".openmausbot-secrets", "thread1", "card3");
      writeFileSync(wrong, "nfp_RevokedTokenNeverReal", { mode: 0o600 });
      const refused = await run(["--delete", "--token-file", wrong], {}, folder);
      rmSync(wrong);
      expect(refused).toMatchObject({ code: 1, json: { ok: false, error: "Deleting the site: Netlify answered 401: Access Denied" } });
      expect(refused.stdout).not.toContain("nfp_Revoked");
      expect(fake.sites.has(siteId)).toBe(true);
      expect(readdirSync(folder).sort()).toEqual([helper.SITE_FILE, "out"]);

      fake.failNext(500, { message: "Internal error" });
      const failed = await run(["--delete", "--token-file", tokenFile], {}, folder);
      expect(failed.json).toMatchObject({ ok: false, error: "Deleting the site: Netlify answered 500: Internal error" });
      expect(readdirSync(folder).sort()).toEqual([helper.SITE_FILE, "out"]);

      const mixed = await run(["--delete", "--dir", "out", "--token-file", tokenFile], {}, folder);
      expect(String(mixed.json.error)).toMatch(/--delete takes only --token-file and --project/);
      expect(fake.sites.has(siteId)).toBe(true);
    });
  });

  it("needs an index.html at the top of the published folder", async () => {
    const empty = await run(["--dir", "dist/assets", "--token-file", tokenFile]);
    expect(String(empty.json.error)).toMatch(/has no index\.html at its top/);
  });
});
