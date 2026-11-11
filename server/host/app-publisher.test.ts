import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeAppHosting, type FakeAppHosting } from "../testing/fake-app-hosting.ts";
import { collectAppFiles, createAppPublisher, needsOwnNetlify, publishable, type AppPublishAnswer } from "./app-publisher.ts";
import { createIncludedHosting, DEFAULT_HOSTING_LIMITS } from "./included-hosting.ts";
import { SITE_FILE } from "./netlify-sites.ts";

const TOKEN = "omb_host_publisher_test_token_0123456789abcdef";
const PAGE = (title: string) => `<!doctype html><title>${title}</title><link rel="stylesheet" href="style.css"><h1>${title}</h1>`;

/** Windows makes a file link only with a privilege CI lacks; a folder junction needs none. */
const FILE_LINKS = process.platform !== "win32";
const folderLink = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
/** Windows cannot create a file whose name holds `?`. */
const ODD_NAMES = process.platform !== "win32";

let dataDir = "", fake: FakeAppHosting, warnings: string[];
let credential: { token: string; api: string; included: boolean } | null;
const workspace = (botId: string) => join(dataDir, "workspaces", botId);
const roots = (botId: string) => [workspace(botId)];

function write(botId: string, path: string, content: string | Buffer): string {
  const file = join(workspace(botId), path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  return file;
}
function site(botId: string, folder: string, title = "Bakery order page") {
  write(botId, `${folder}/index.html`, PAGE(title));
  write(botId, `${folder}/style.css`, "h1{color:teal}");
}
function publisher(over: Partial<Parameters<typeof createAppPublisher>[0]> = {}) {
  const hosting = createIncludedHosting({ credential: () => credential, dataDir, warn: (line) => warnings.push(line) });
  return { hosting, publisher: createAppPublisher({ hosting, botName: (id) => (id === "mira" ? "Mira" : "Otto"), botFolder: workspace, home: "/nowhere/home", env: {}, pollMs: 10, waitMs: 3_000, linkWaitMs: 400, ...over }) };
}
const record = (botId: string, folder: string) => JSON.parse(readFileSync(join(workspace(botId), folder, SITE_FILE), "utf8")) as Record<string, unknown>;
const everything = (answer: AppPublishAnswer, ...more: unknown[]) => JSON.stringify([answer, warnings, ...more]);

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "app-publisher-")));
  mkdirSync(workspace("mira"), { recursive: true });
  mkdirSync(workspace("otto"), { recursive: true });
  fake = await startFakeAppHosting(TOKEN);
  credential = { token: TOKEN, api: fake.url, included: true };
  warnings = [];
});
afterEach(async () => { await fake.stop(); rmSync(dataDir, { recursive: true, force: true }); });

describe("publishing a bot's folder on the plan's included hosting", () => {
  it("publishes the folder, checks the link serves a web page and leaves the record the page lists", async () => {
    site("mira", "bakery");
    const answer = await publisher().publisher.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(answer.status).toBe(200);
    const [app] = [...fake.apps.values()];
    expect(answer.body).toMatchObject({
      ok: true, state: "ready", live: true, liveStatus: 200, created: true, files: 2, uploaded: 2, skipped: [], url: `${fake.liveUrl(app!.key)}`,
      apps: "1 of 10", publishesThisMonth: "1 of 200", message: "Published. The link is public: anyone who has it can open it.",
    });
    expect(await (await fetch(String(answer.body.url))).text()).toContain("<h1>Bakery order page</h1>");
    expect(record("mira", "bakery")).toEqual({
      version: 1, hosting: "included", appKey: app!.key, siteId: app!.key, url: answer.body.url, title: "Bakery order page", botId: "mira", botName: "Mira",
      createdAt: expect.stringMatching(/^2\d{3}-/), publishedAt: expect.stringMatching(/^2\d{3}-/), deployState: "ready", access: "public",
    });
    expect(fake.requests).toEqual(["GET /apps", `PUT /apps/${app!.key}`, expect.stringMatching(/^PUT \/apps\/app-[0-9a-f]{32}\/files\/[0-9a-f]{40}$/), expect.stringMatching(/\/files\//), `GET /apps/${app!.key}`]);
    expect(fake.refused).toEqual([]);
    expect(everything(answer, record("mira", "bakery"))).not.toContain(TOKEN);
  });

  it("updates the same app from the same project folder, uploading only the files that changed", async () => {
    site("mira", "bakery");
    const { publisher: made } = publisher();
    const first = await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    const created = record("mira", "bakery").createdAt;
    fake.uploads.length = 0;
    write("mira", "bakery/index.html", PAGE("Bakery, now with cakes"));
    const second = await made.publish({ botId: "mira", roots: roots("mira"), path: join(workspace("mira"), "bakery"), title: "Bakery with cakes" });
    expect(second.body).toMatchObject({ ok: true, live: true, created: false, files: 2, uploaded: 1, url: first.body.url, apps: "1 of 10", publishesThisMonth: "2 of 200" });
    expect(fake.uploads).toEqual(["index.html"]);
    expect(fake.apps.size).toBe(1);
    expect(record("mira", "bakery")).toMatchObject({ title: "Bakery with cakes", createdAt: created });
    expect(await (await fetch(String(second.body.url))).text()).toContain("now with cakes");
  });

  it("keeps the record in the project folder when the built output is inside it", async () => {
    site("mira", "shop/dist");
    const { publisher: made, hosting } = publisher();
    const answer = await made.publish({ botId: "mira", roots: roots("mira"), path: "shop/dist", project: "shop", title: "Shop" });
    expect(answer.body).toMatchObject({ ok: true, live: true });
    expect(existsSync(join(workspace("mira"), "shop", "dist", SITE_FILE))).toBe(false);
    expect(record("mira", "shop").appKey).toBe(await hosting.keyFor("mira", join(workspace("mira"), "shop")));
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "shop", project: "shop/dist", title: "Shop" })).body.error).toContain("path must be the project folder or a folder inside it");
  });

  it("gives two bots, and two folders of one bot, apps of their own", async () => {
    site("mira", "bakery");
    site("mira", "rota");
    site("otto", "bakery");
    const { publisher: made } = publisher();
    for (const [botId, folder] of [["mira", "bakery"], ["mira", "rota"], ["otto", "bakery"]] as const) {
      expect((await made.publish({ botId, roots: roots(botId), path: folder, title: folder })).status).toBe(200);
    }
    expect(new Set([record("mira", "bakery").appKey, record("mira", "rota").appKey, record("otto", "bakery").appKey]).size).toBe(3);
    expect(fake.apps.size).toBe(3);
  });

  it("opens a new app to everyone where the relay still keeps new apps private", async () => {
    await fake.stop();
    fake = await startFakeAppHosting(TOKEN, { privateFirst: true });
    credential = { token: TOKEN, api: fake.url, included: true };
    site("mira", "bakery");
    const answer = await publisher().publisher.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(answer.body).toMatchObject({ ok: true, live: true, liveStatus: 200 });
    expect(fake.requests.at(-1)).toMatch(/^PATCH \/apps\/app-/);
    expect([...fake.apps.values()][0]!.visibility).toBe("public");
    expect(record("mira", "bakery").access).toBe("public");
  });

  it("says a publish is still being processed instead of calling it live or failed, and status picks it up", async () => {
    site("mira", "bakery");
    fake.processingPolls = 1_000;
    const { publisher: made } = publisher({ waitMs: 60 });
    const pending = await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(pending).toMatchObject({ status: 200, body: { ok: true, pending: true, live: false, state: "processing" } });
    expect(String(pending.body.message)).toContain("still being processed");
    expect(record("mira", "bakery")).toMatchObject({ hosting: "included", deployState: "processing" });
    expect(record("mira", "bakery")).not.toHaveProperty("publishedAt");
    [...fake.apps.values()][0]!.pollsLeft = 0;
    const status = await made.status({ botId: "mira", roots: roots("mira"), path: "bakery" });
    expect(status.body).toMatchObject({ ok: true, state: "ready", live: true, title: "Bakery order page", apps: "1 of 10", publishesThisMonth: "1 of 200" });
    expect(record("mira", "bakery")).toMatchObject({ deployState: "ready", access: "public" });
  });

  it("does not call a link published when it answers as something other than a web page", async () => {
    site("mira", "bakery");
    fake.rootContentType = "text/plain";
    const answer = await publisher().publisher.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(answer.body).toMatchObject({ ok: true, live: false, liveStatus: 200, contentType: "text/plain" });
    expect(String(answer.body.message)).toContain("not as a web page");
  });

  it("says how much of the plan is used before anything is published", async () => {
    const answer = await publisher().publisher.status({ botId: "mira", roots: roots("mira") });
    expect(answer).toEqual({ status: 200, body: { ok: true, apps: "0 of 10", publishesThisMonth: "0 of 200", limits: "25 MB and 500 files an app, 8 MB a file", projects: [] } });
    expect(fake.requests).toEqual(["GET /apps"]);
  });
});

describe("a project in the bot's shared folder, from any conversation with that bot", () => {
  const conversation = (threadId: string) => join(dataDir, "task-workspaces", "mira", threadId);
  const turnRoots = (threadId: string) => { mkdirSync(conversation(threadId), { recursive: true }); return [conversation(threadId), workspace("mira")]; };

  it("lets a second conversation find the app and publish it again to the same link", async () => {
    site("mira", "sites/bakery");
    const { publisher: made } = publisher();
    const first = await made.publish({ botId: "mira", roots: turnRoots("monday"), path: "sites/bakery", title: "Bakery order page" });
    expect(first.body).toMatchObject({ ok: true, live: true, created: true });
    expect(first.body).not.toHaveProperty("note");

    const found = await made.status({ botId: "mira", roots: turnRoots("friday") });
    // The record's address is a loopback one here, which a record is never trusted for; a real https one is listed.
    expect(found.body.projects).toEqual([{ title: "Bakery order page", folder: join(workspace("mira"), "sites", "bakery"), on: "included hosting" }]);
    write("mira", "sites/bakery/index.html", PAGE("Bakery, now with cakes"));
    const second = await made.publish({ botId: "mira", roots: turnRoots("friday"), path: "sites/bakery", title: "Bakery order page" });
    expect(second.body).toMatchObject({ ok: true, live: true, created: false, url: first.body.url, uploaded: 1, apps: "1 of 10" });
    expect(fake.apps.size).toBe(1);
    expect(await (await fetch(String(second.body.url))).text()).toContain("now with cakes");
  });

  it("reads a relative path in the shared folder first, whatever the conversation's own folder holds", async () => {
    site("mira", "sites/bakery");
    const { publisher: made } = publisher();
    const first = await made.publish({ botId: "mira", roots: turnRoots("monday"), path: "sites/bakery", title: "Bakery order page" });
    mkdirSync(join(conversation("friday"), "sites", "bakery"), { recursive: true });
    writeFileSync(join(conversation("friday"), "sites", "bakery", "index.html"), PAGE("A stray copy"));
    const second = await made.publish({ botId: "mira", roots: turnRoots("friday"), path: "sites/bakery", title: "Bakery order page" });
    expect(second.body).toMatchObject({ created: false, url: first.body.url });
    expect(existsSync(join(conversation("friday"), "sites", "bakery", SITE_FILE))).toBe(false);
  });

  it("says so when a new app's project is in one conversation's folder, where no other conversation finds it", async () => {
    mkdirSync(join(conversation("monday"), "bakery"), { recursive: true });
    writeFileSync(join(conversation("monday"), "bakery", "index.html"), PAGE("Bakery order page"));
    const { publisher: made } = publisher();
    const first = await made.publish({ botId: "mira", roots: turnRoots("monday"), path: "bakery", title: "Bakery order page" });
    expect(first.body).toMatchObject({ ok: true, live: true, created: true });
    expect(String(first.body.note)).toContain("another conversation with you won't find it");
    expect((await made.publish({ botId: "mira", roots: turnRoots("monday"), path: "bakery", title: "Bakery order page" })).body).not.toHaveProperty("note");
    expect((await made.publish({ botId: "mira", roots: turnRoots("friday"), path: "bakery", title: "Bakery order page" })).body.error).toBe("No folder was found at bakery. Pass the exact path of the folder to publish.");
    expect((await made.status({ botId: "mira", roots: turnRoots("friday") })).body.projects).toEqual([]);
  });

  it("lists a site on the person's own Netlify account beside the included ones", async () => {
    write("mira", `sites/rota/${SITE_FILE}`, JSON.stringify({ version: 1, siteId: "3f2a6c1e", url: "https://staff-rota.netlify.app", title: "Staff rota" }));
    expect((await publisher().publisher.status({ botId: "mira", roots: turnRoots("friday") })).body.projects)
      .toEqual([{ title: "Staff rota", folder: join(workspace("mira"), "sites", "rota"), url: "https://staff-rota.netlify.app/", on: "the person's own Netlify" }]);
  });
});

describe("what never leaves the bot's folder", () => {
  it("leaves out dotfiles, env files, keys, node_modules and links, and says which", async () => {
    site("mira", "bakery");
    write("otto", "notes.txt", "otto's private notes");
    for (const path of [".env", ".git/config", ".openmausbot-secrets/netlify", "prod.env", "server.pem", "id_rsa", "credentials.json", "node_modules/pkg/index.js", "Thumbs.db", ...(ODD_NAMES ? ["what?.html"] : [])]) write("mira", `bakery/${path}`, "SECRET");
    write("mira", "bakery/.well-known/security.txt", "Contact: hello@example.test");
    if (FILE_LINKS) symlinkSync(join(workspace("otto"), "notes.txt"), join(workspace("mira"), "bakery", "linked.txt"));
    folderLink(workspace("otto"), join(workspace("mira"), "bakery", "linked-folder"));
    const answer = await publisher().publisher.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(answer.body).toMatchObject({ ok: true, live: true, files: 3 });
    expect((answer.body.skipped as string[]).sort()).toEqual([".env", ".git", ".openmausbot-secrets", "Thumbs.db", "credentials.json", "id_rsa", "linked-folder", ...(FILE_LINKS ? ["linked.txt"] : []),
      "node_modules", "prod.env", "server.pem", ...(ODD_NAMES ? ["what?.html"] : [])]);
    expect(Object.keys([...fake.apps.values()][0]!.files).sort()).toEqual([".well-known/security.txt", "index.html", "style.css"]);
    expect(fake.uploads.sort()).toEqual([".well-known/security.txt", "index.html", "style.css"]);
  });

  it("never takes a name a published path can't hold, whatever the computer lets a folder contain", () => {
    for (const path of ["what?.html", "a#b.html", "docs/what?.html", "a\\b\\.env"]) expect(publishable(path), path).toBe(false);
    for (const path of ["what.html", "docs/a b.html", "a-b_c.html"]) expect(publishable(path), path).toBe(true);
  });

  it("keeps the same file filter as the publish helper", async () => {
    const helper = await import(pathToFileURL(join(process.cwd(), "skills", "publish-to-netlify", "deploy.mjs")).href) as { publishable(path: string): boolean };
    const paths = ["index.html", "assets/app.js", ".env", "a/.env.local", "env", "env.production", ".well-known/x", ".git/HEAD", "node_modules/a.js", "__MACOSX/a", "Thumbs.db", "a/Thumbs.db",
      "key.pem", "site.key", "id_ed25519.pub", "secrets.yaml", "secret.json", "credentials.prod.json", "service-account.json", "npmrc", "netrc", "htpasswd", "a#b.html", "a?b", "report.env.txt",
      ".netlify-site.json", "x/.hidden/y", "", "a\\b\\.env", "data.json", "_redirects", "netlify.toml"];
    for (const path of paths) expect(publishable(path), path).toBe(helper.publishable(path));
  });

  it("refuses a folder outside the bot's own: another bot's, a path that climbs out, a link out", async () => {
    site("otto", "private-site", "Otto's draft");
    site("mira", "bakery");
    folderLink(join(workspace("otto"), "private-site"), join(workspace("mira"), "borrowed"));
    const { publisher: made } = publisher();
    for (const path of [join(workspace("otto"), "private-site"), "../otto/private-site", "bakery/../../otto/private-site", "borrowed", dataDir, "/"]) {
      const answer = await made.publish({ botId: "mira", roots: roots("mira"), path, title: "Mine now" });
      expect(answer, path).toEqual({ status: 400, body: { error: "Only a folder inside your own working folder can be published. Build the app there first.", code: "failed" } });
    }
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", project: "../otto", title: "Mine now" })).body.error).toContain("Only a folder inside your own working folder");
    expect((await made.status({ botId: "mira", roots: roots("mira"), path: "../otto/private-site" })).body.error).toContain("Only a folder inside your own working folder");
    expect((await made.remove({ botId: "mira", roots: roots("mira"), path: join(workspace("otto"), "private-site") })).body.error).toContain("Only a folder inside your own working folder");
    expect(fake.requests.filter((line) => !line.startsWith("GET /apps"))).toEqual([]);
    expect(existsSync(join(workspace("otto"), "private-site", SITE_FILE))).toBe(false);
  });

  it("never reads through a link, even one that points inside the bot's own folder, and names paths with /", async () => {
    site("mira", "bakery");
    write("mira", "bakery/assets/img/logo.svg", "<svg/>");
    write("mira", "notes/private.txt", "not for the web");
    if (FILE_LINKS) symlinkSync(join(workspace("mira"), "notes", "private.txt"), join(workspace("mira"), "bakery", "notes.txt"));
    folderLink(join(workspace("mira"), "notes"), join(workspace("mira"), "bakery", "more"));
    const collected = await collectAppFiles(join(workspace("mira"), "bakery"), DEFAULT_HOSTING_LIMITS);
    expect(collected.files.map((file) => file.path)).toEqual(["assets/img/logo.svg", "index.html", "style.css"]);
    expect(collected.skipped).toEqual(["more", ...(FILE_LINKS ? ["notes.txt"] : [])]);
  });

  it.skipIf(!FILE_LINKS)("replaces a record the bot swapped for a link instead of writing through it", async () => {
    site("mira", "bakery");
    const target = write("otto", "config.json", "{\"otto\":true}");
    symlinkSync(target, join(workspace("mira"), "bakery", SITE_FILE));
    const answer = await publisher().publisher.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(answer.body).toMatchObject({ ok: true, live: true });
    expect(readFileSync(target, "utf8")).toBe("{\"otto\":true}");
    expect(lstatSync(join(workspace("mira"), "bakery", SITE_FILE)).isSymbolicLink()).toBe(false);
    expect(record("mira", "bakery")).toMatchObject({ hosting: "included" });
  });

  it("refuses the secret folder, a file, a missing folder and a folder with no index.html in plain words", async () => {
    write("mira", ".openmausbot-secrets/site/index.html", "x");
    write("mira", "notes/readme.md", "x");
    const { publisher: made } = publisher();
    const ask = async (path: string, title = "Site") => (await made.publish({ botId: "mira", roots: roots("mira"), path, title })).body.error;
    expect(await ask(".openmausbot-secrets/site")).toContain("holds a secret the person gave");
    expect(await ask("notes/readme.md")).toBe("notes/readme.md is a file. Publish the folder that holds the app's index.html.");
    expect(await ask("nowhere")).toBe("No folder was found at nowhere. Pass the exact path of the folder to publish.");
    expect(await ask("notes")).toBe("notes has no index.html at its top. Publish the built output folder.");
    expect(await ask("notes", " ")).toBe("title is required: what the app is, in a few words.");
    expect(fake.apps.size).toBe(0);
  });
});

describe("what included hosting leaves to the person's own Netlify account", () => {
  const OFFER = "offer to publish on their own Netlify account instead (deploy.mjs in the publish-to-netlify skill).";

  it("refuses an app that needs redirects, Netlify settings, functions or a server, before anything is sent", async () => {
    expect([needsOwnNetlify("_redirects"), needsOwnNetlify("netlify.toml"), needsOwnNetlify("netlify/functions/a.mjs"), needsOwnNetlify("docs/_redirects"), needsOwnNetlify("index.html")])
      .toEqual(["redirects (a _redirects file)", "Netlify settings (a netlify.toml file)", "functions, a database or a server (a netlify folder)", null, null]);
    const { publisher: made } = publisher();
    for (const [file, words] of [["_redirects", "redirects"], ["netlify.toml", "Netlify settings"], ["netlify/functions/order.mjs", "functions, a database or a server"]] as const) {
      const folder = `app-${words.length}`;
      site("mira", folder);
      write("mira", `${folder}/${file}`, "x");
      const answer = await made.publish({ botId: "mira", roots: roots("mira"), path: folder, title: "Shop" });
      expect(answer, file).toMatchObject({ status: 409, body: { code: "needs_own_netlify", offerOwnNetlify: true } });
      expect(String(answer.body.error)).toContain(`This app uses ${words}`);
      expect(String(answer.body.error)).toContain(OFFER);
    }
    expect(fake.requests.every((line) => line === "GET /apps")).toBe(true);
  });

  it("refuses more than the plan's sizes with the numbers, before anything is sent", async () => {
    const { publisher: made } = publisher();
    site("mira", "big-file");
    write("mira", "big-file/video.bin", Buffer.alloc(3 * 1024 * 1024));
    fake.limits = { maxBytes: 25 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxFiles: 500 };
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "big-file", title: "Big" })).body).toEqual({
      error: `"video.bin" is 3 MB; included hosting takes files up to 2 MB. Tell the person, and ${OFFER}`, code: "too_large", offerOwnNetlify: true });
    site("mira", "many");
    for (let n = 0; n < 4; n += 1) write("mira", `many/${n}.txt`, "x");
    fake.limits = { maxBytes: 1_000_000, maxFileBytes: 1_000_000, maxFiles: 5 };
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "many", title: "Many" })).body.error).toContain("more than 5 files, the most included hosting takes");
    site("mira", "heavy");
    write("mira", "heavy/a.bin", Buffer.alloc(3 * 1024 * 1024));
    fake.limits = { maxBytes: 2 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024, maxFiles: 500 };
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "heavy", title: "Heavy" })).body.error).toContain("larger than 2 MB, the most included hosting takes");
    expect(fake.requests.every((line) => line === "GET /apps")).toBe(true);
  });

  it("says in plain words when the plan's apps or the month's publishes are used up, with the numbers", async () => {
    const { publisher: made } = publisher();
    fake.plan.apps = 1;
    site("mira", "first");
    site("mira", "second");
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "first", title: "First" })).body).toMatchObject({ ok: true, apps: "1 of 1" });
    const full = await made.publish({ botId: "mira", roots: roots("mira"), path: "second", title: "Second" });
    expect(full).toEqual({ status: 409, body: { code: "apps_limit_reached", offerOwnNetlify: true,
      error: `The plan's included hosting is full: 1 of 1 apps are in use. The person can delete one on the Published apps page to make room. Tell the person, and ${OFFER}` } });
    expect(existsSync(join(workspace("mira"), "second", SITE_FILE))).toBe(false);
    fake.plan.publishes = 1;
    const used = await made.publish({ botId: "mira", roots: roots("mira"), path: "first", title: "First" });
    expect(used).toEqual({ status: 409, body: { code: "publishes_limit_reached", offerOwnNetlify: true,
      error: `This month's included publishes are used up (1 of 1); they start again on 2026-12-01. What is already published stays online. Tell the person, and ${OFFER}` } });
  });

  it("turns every other refusal of the relay into its own words, never the relay's", async () => {
    site("mira", "bakery");
    const { publisher: made } = publisher();
    const cases: Array<[number, Record<string, unknown>, string, string]> = [
      [402, { error: "not_included", message: "RELAY WORDS" }, "not_included", "This Cloud's plan doesn't include app hosting yet (a free trial gets it with its first payment)."],
      [402, { error: "subscription_inactive", message: "RELAY WORDS" }, "plan_ended", "This Cloud's plan has ended, so its included hosting is off."],
      [503, { error: "service_unavailable", message: "RELAY WORDS" }, "unavailable", "Included hosting isn't available right now. It is not something the person can fix; try again in a few minutes."],
      [401, { error: "invalid_api_key", message: "RELAY WORDS" }, "unavailable", "Included hosting isn't available right now. It is not something the person can fix"],
      [502, { error: "upstream_error", message: "RELAY WORDS" }, "unavailable", "Included hosting isn't available right now."],
      [429, { error: "busy", message: "RELAY WORDS" }, "busy", "Included hosting is busy right now. Try again in a few minutes."],
      [409, { error: "change_in_progress", message: "RELAY WORDS" }, "in_progress", "Another change to this app is still running."],
      [409, { error: "app_taken_down", message: "RELAY WORDS" }, "taken_down", "This app was taken down by MausBot, so it can't be published again."],
      [413, { error: "too_many_files", message: "RELAY WORDS", files: 612, max: 500 }, "too_large", "The app has 612 files; included hosting takes at most 500."],
      [413, { error: "file_too_large", message: "RELAY WORDS", path: "film.mp4", size: 9 * 1024 * 1024, max: 8 * 1024 * 1024 }, "too_large", "\"film.mp4\" is 9 MB; included hosting takes files up to 8 MB."],
      [413, { error: "app_too_large", message: "RELAY WORDS", bytes: 30 * 1024 * 1024, max: 25 * 1024 * 1024 }, "too_large", "The app is 30 MB; included hosting takes apps up to 25 MB."],
      [400, { error: "invalid_files", message: "RELAY WORDS", path: "odd\u0007name.html" }, "invalid_files", "Included hosting can't publish \"oddname.html\""],
      [400, { error: "brand_new_code", message: "RELAY WORDS" }, "failed", "Included hosting could not do that. Try again."],
    ];
    for (const [status, body, code, words] of cases) {
      fake.failNext(status, body);
      fake.requests.length = 0;
      const answer = await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
      expect(answer.body.code, String(body.error)).toBe(code);
      expect(String(answer.body.error), String(body.error)).toContain(words);
      expect(JSON.stringify(answer)).not.toContain("RELAY WORDS");
      expect(everything(answer)).not.toContain(TOKEN);
    }
    expect(warnings).toEqual(["included app hosting: the relay refused this home's token; the Admin has to re-issue it"]);
  });

  it("keeps a project that is already on the person's own Netlify account there", async () => {
    site("mira", "bakery");
    write("mira", `bakery/${SITE_FILE}`, JSON.stringify({ version: 1, siteId: "3f2a6c1e", name: "bright-bakery", url: "https://bright-bakery.netlify.app", adminUrl: "https://app.netlify.com/projects/bright-bakery" }));
    const answer = await publisher().publisher.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(answer.body.error).toBe("This project is already published on the person's own Netlify account (https://bright-bakery.netlify.app/). Keep updating it there with deploy.mjs, so its link stays the same.");
    expect(fake.requests).toEqual([]);
    expect(record("mira", "bakery")).not.toHaveProperty("hosting");
  });
});

describe("deleting, a takedown and a server with no included hosting", () => {
  it("deletes the app published from a folder, frees its place and removes the record, keeping the files", async () => {
    site("mira", "bakery");
    const { publisher: made } = publisher();
    const published = await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    const removed = await made.remove({ botId: "mira", roots: roots("mira"), path: "bakery" });
    expect(removed).toEqual({ status: 200, body: { ok: true, deleted: true, title: "Bakery order page", url: published.body.url, apps: "0 of 10", publishesThisMonth: "1 of 200",
      message: "The app was deleted and its link no longer works. Your files stay." } });
    expect(fake.apps.size).toBe(0);
    expect(existsSync(join(workspace("mira"), "bakery", SITE_FILE))).toBe(false);
    expect(existsSync(join(workspace("mira"), "bakery", "index.html"))).toBe(true);
    expect((await fetch(String(published.body.url))).status).toBe(404);
    expect((await made.remove({ botId: "mira", roots: roots("mira"), path: "bakery" })).body).toEqual({ error: "Nothing is published from this folder on the plan's included hosting.", code: "not_found" });
  });

  it("never removes the record of a site on the person's own Netlify account", async () => {
    site("mira", "bakery");
    const own = JSON.stringify({ version: 1, siteId: "3f2a6c1e", url: "https://bright-bakery.netlify.app" });
    write("mira", `bakery/${SITE_FILE}`, own);
    expect((await publisher().publisher.remove({ botId: "mira", roots: roots("mira"), path: "bakery" })).body.code).toBe("not_found");
    expect(readFileSync(join(workspace("mira"), "bakery", SITE_FILE), "utf8")).toBe(own);
  });

  it("reports an app MausBot took down and refuses to publish it again", async () => {
    site("mira", "bakery");
    const { publisher: made } = publisher();
    await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    fake.takeDown(String(record("mira", "bakery").appKey));
    const status = await made.status({ botId: "mira", roots: roots("mira"), path: "bakery" });
    expect(status.body).toMatchObject({ ok: true, state: "taken_down", live: false, message: "This app was taken down by MausBot. Its link no longer works." });
    expect(record("mira", "bakery").deployState).toBe("taken_down");
    const again = await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" });
    expect(again).toMatchObject({ status: 409, body: { code: "taken_down" } });
    expect(String(again.body.error)).toContain("was taken down by MausBot, so it can't be published again");
  });

  it("answers that there is no included hosting where the Admin gave none, and reaches nothing", async () => {
    site("mira", "bakery");
    credential = null;
    const { publisher: made, hosting } = publisher();
    expect(hosting.available()).toBe(false);
    for (const answer of [await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" }), await made.status({ botId: "mira", roots: roots("mira") }),
      await made.remove({ botId: "mira", roots: roots("mira"), path: "bakery" })]) {
      expect(answer).toEqual({ status: 502, body: { code: "unavailable", offerOwnNetlify: true,
        error: "This server has no included app hosting. Publish on the person's own Netlify account (deploy.mjs in the publish-to-netlify skill)." } });
    }
    expect(fake.requests).toEqual([]);
    expect(existsSync(join(workspace("mira"), "bakery", SITE_FILE))).toBe(false);
  });

  it("sends the token to the relay and nowhere else: not to the app's own address", async () => {
    site("mira", "bakery");
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return fetch(input, init);
    }) as typeof fetch;
    const hosting = createIncludedHosting({ credential: () => credential, dataDir, fetch: spy });
    const made = createAppPublisher({ hosting, botName: () => "Mira", botFolder: workspace, home: "/nowhere/home", env: {}, fetch: spy, pollMs: 10, linkWaitMs: 400 });
    expect((await made.publish({ botId: "mira", roots: roots("mira"), path: "bakery", title: "Bakery order page" })).body).toMatchObject({ live: true });
    const live = seen.filter((call) => call.url.includes("/live/"));
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((call) => call.authorization === null)).toBe(true);
    expect(seen.filter((call) => call.authorization !== null).every((call) => call.url.startsWith(`${fake.url}/`) && call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
