import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { startFakeAppHosting, type FakeAppHosting } from "../testing/fake-app-hosting.ts";
import { createAppPublisher } from "./app-publisher.ts";
import { createIncludedHosting } from "./included-hosting.ts";
import { SITE_FILE } from "./netlify-sites.ts";
import { createPublishedApps, type PublishedAppsDeps } from "./published-apps.ts";

const ADA = "ada@acme.test", BEN = "ben@acme.test", OLIVE = "olive@acme.test";
const KEYS: Record<string, string> = { [ADA]: "p_adaadaadaadaadaadaada1", [BEN]: "p_benbenbenbenbenbenben1", [OLIVE]: "p_oliveoliveoliveolive01" };
const TOKEN = "omb_host_published_apps_token_0123456789abcdef";

const bots = [
  { id: "mira", name: "Mira", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "ada-chat" }, { threadId: "ben-chat" }] },
  { id: "bens-own", name: "Ledger", threadId: "ledger-main", createdBy: BEN, tasks: [{ threadId: "ledger-main" }] },
];
const rooms = [{ id: "launch", threadId: "room-thread", memberIds: ["mira"] }];
const audienceOf = (threadId: string) => threadId.startsWith("ada-") ? `member:${KEYS[ADA]}` as const : threadId.startsWith("ben-") ? `member:${KEYS[BEN]}` as const
  : threadId === "room-thread" ? "room:launch" as const : "team" as const;
const session = (email: string, admin = false) => ({ kind: "session", scopes: admin ? ["admin", "client"] : ["client"], session: { id: `s-${email}`, email } }) as unknown as RequestAuth;
const OWNER = { kind: "loopback", trust: "owner", scopes: ["admin", "client"] } as unknown as RequestAuth;
const emailOf = (auth: RequestAuth) => (auth.kind === "session" ? auth.session.email ?? "" : "");

function visibleFor(auth: RequestAuth, team: boolean): VisibleSet {
  const email = emailOf(auth);
  const viewer: Viewer = auth.kind !== "session" ? { kind: "all" } : auth.scopes.includes("admin") ? { kind: "all", email } : { kind: "member", email };
  return new VisibleSet(bots, rooms, viewer, undefined, team ? { of: audienceOf, person: KEYS[email] ?? null } : undefined);
}

let dataDir = "", fake: FakeAppHosting;
let credential: { token: string; api: string; included: boolean } | null;
let messages: Record<string, Array<{ role: string; text?: string; from?: { botId?: string } }>>;
const workspace = (botId: string) => join(dataDir, "workspaces", botId);
const ownFolder = (botId: string, threadId: string) => join(dataDir, "task-workspaces", botId, threadId);
const folders = (bot: { id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> }) =>
  [workspace(bot.id), ...[bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)].map((threadId) => ownFolder(bot.id, threadId))];

function made(over: Partial<PublishedAppsDeps> = {}) {
  const hosting = createIncludedHosting({ credential: () => credential, dataDir });
  const publisher = createAppPublisher({ hosting, botName: (id) => bots.find((bot) => bot.id === id)?.name ?? "", env: {}, pollMs: 10, linkWaitMs: 300 });
  const apps = createPublishedApps({
    bots: () => bots, rooms: () => rooms, messages: (threadId) => messages[threadId] ?? [], folders, ownFolder,
    pages: () => [], unpublishPage: async () => ({ status: 200, text: "Unpublished." }), netlifyToken: () => null,
    ownChat: (auth, threadId) => audienceOf(threadId) === `member:${KEYS[emailOf(auth)]}`,
    included: { hosting, publisher }, home: "/nowhere/home", env: {}, now: () => Date.now(), ...over,
  });
  return { apps, publisher, hosting };
}

/** A bot publishes a folder of its own with the real publisher: `folder` is absolute. */
async function publish(botId: string, folder: string, title: string): Promise<{ key: string; url: string }> {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.html"), `<!doctype html><title>${title}</title><h1>${title}</h1>`);
  const answer = await made().publisher.publish({ botId, roots: folders(bots.find((bot) => bot.id === botId)!), path: folder, title });
  expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ ok: true, live: true });
  return { key: String(JSON.parse(readFileSync(join(folder, SITE_FILE), "utf8")).appKey), url: String(answer.body.url) };
}

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "published-apps-included-")));
  for (const bot of bots) mkdirSync(workspace(bot.id), { recursive: true });
  fake = await startFakeAppHosting(TOKEN, { apps: 20 });
  credential = { token: TOKEN, api: fake.url, included: true };
  messages = {};
});
afterEach(async () => { await fake.stop(); rmSync(dataDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("the plan's included apps on a person's own Cloud", () => {
  it("lists each app under the bot whose folder holds its record, with the address the relay gives and the plan's count", async () => {
    const bakery = await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    const { apps } = made();
    const listed = await apps.list(visibleFor(OWNER, false), OWNER);
    expect(listed).toEqual([{
      id: `included-${bakery.key}`, source: "included", title: "Bakery order page", url: bakery.url, bot: { id: "mira", name: "Mira" },
      publishedAt: expect.any(Number), access: "public", canDelete: true,
    }]);
    expect(await apps.allowance()).toEqual({ used: 1, max: 20 });
    expect(await apps.lists(visibleFor(OWNER, false), OWNER, `${bakery.url}menu.html`)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
  });

  it("takes the address and the title from the relay, never from what a bot wrote in the record", async () => {
    const bakery = await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    const file = join(workspace("mira"), "bakery", SITE_FILE);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), url: "https://phishing.example.test/login", title: "Your bank" }));
    const [app] = await made().apps.list(visibleFor(OWNER, false), OWNER);
    expect(app).toMatchObject({ title: "Bakery order page", url: bakery.url });
  });

  it("does not let a record copied into another bot's folder claim the app", async () => {
    const ledger = await publish("bens-own", join(workspace("bens-own"), "ledger"), "Ledger");
    mkdirSync(join(workspace("mira"), "planted"), { recursive: true });
    writeFileSync(join(workspace("mira"), "planted", SITE_FILE), readFileSync(join(workspace("bens-own"), "ledger", SITE_FILE)));
    const listed = await made().apps.list(visibleFor(OWNER, false), OWNER);
    expect(listed.map((app) => [app.id, app.bot.id])).toEqual([[`included-${ledger.key}`, "bens-own"]]);
  });

  it("shows an app MausBot took down, and one that was never live, without an address to open as live", async () => {
    const bakery = await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    const rota = await publish("mira", join(workspace("mira"), "rota"), "Staff rota");
    fake.takeDown(bakery.key);
    Object.assign(fake.apps.get(rota.key)!, { state: "processing", publishedAt: null, pollsLeft: 1_000 });
    const listed = await made().apps.list(visibleFor(OWNER, false), OWNER);
    expect(Object.fromEntries(listed.map((app) => [app.title, [app.status, app.access, app.canDelete]]))).toEqual({
      "Bakery order page": ["taken_down", "unknown", true], "Staff rota": ["not_live", "unknown", true],
    });
  });

  it("shows the owner an app whose project folder is gone, so its place can be freed", async () => {
    const bakery = await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    rmSync(join(workspace("mira"), "bakery"), { recursive: true });
    const { apps } = made();
    const [orphan] = await apps.list(visibleFor(OWNER, false), OWNER);
    expect(orphan).toMatchObject({ id: `included-${bakery.key}`, title: "Bakery order page", bot: { id: "", name: "" }, canDelete: true });
    expect(orphan).not.toHaveProperty("threadId");
    expect(await apps.remove(visibleFor(OWNER, false), OWNER, orphan!.id)).toEqual({ status: 200, body: { ok: true } });
    expect(fake.apps.size).toBe(0);
    expect(await apps.allowance()).toEqual({ used: 0, max: 20 });
  });

  it("deletes through the relay and removes the record, so the card is gone and the files stay", async () => {
    const bakery = await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    await publish("mira", join(workspace("mira"), "rota"), "Staff rota");
    const { apps } = made();
    fake.requests.length = 0;
    expect(await apps.remove(visibleFor(OWNER, false), OWNER, `included-${bakery.key}`)).toEqual({ status: 200, body: { ok: true } });
    expect(fake.requests).toContain(`DELETE /apps/${bakery.key}`);
    expect(existsSync(join(workspace("mira"), "bakery", SITE_FILE))).toBe(false);
    expect(existsSync(join(workspace("mira"), "bakery", "index.html"))).toBe(true);
    expect((await apps.list(visibleFor(OWNER, false), OWNER)).map((app) => app.title)).toEqual(["Staff rota"]);
    expect(await apps.allowance()).toEqual({ used: 1, max: 20 });
  });

  it("says only that it failed when the relay can't delete, and keeps the record", async () => {
    const bakery = await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    const { apps } = made();
    await apps.list(visibleFor(OWNER, false), OWNER);
    fake.failNext(502, { error: "upstream_error", message: `the token was ${TOKEN}` });
    const answer = await apps.remove(visibleFor(OWNER, false), OWNER, `included-${bakery.key}`);
    expect(answer).toEqual({ status: 502, body: { error: "The app could not be deleted. Try again.", code: "failed" } });
    expect(existsSync(join(workspace("mira"), "bakery", SITE_FILE))).toBe(true);
    expect(fake.apps.size).toBe(1);
  });

  it("lists everything else and shows no count when the relay can't be reached", async () => {
    await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    mkdirSync(join(workspace("mira"), "own"), { recursive: true });
    writeFileSync(join(workspace("mira"), "own", SITE_FILE), JSON.stringify({ version: 1, siteId: "id-own", url: "https://own-site.netlify.app", title: "Own site" }));
    const { apps } = made();
    fake.failNext(503, { error: "service_unavailable" });
    expect((await apps.list(visibleFor(OWNER, false), OWNER)).map((app) => [app.title, app.source])).toEqual([["Own site", "netlify"]]);
    expect(await apps.allowance()).toBeNull();
  });

  it("asks the relay nothing and shows no count where the Admin gave no included hosting", async () => {
    await publish("mira", join(workspace("mira"), "bakery"), "Bakery order page");
    credential = null;
    fake.requests.length = 0;
    const { apps } = made();
    expect(await apps.list(visibleFor(OWNER, false), OWNER)).toEqual([]);
    expect(await apps.allowance()).toBeNull();
    expect(await made({ included: undefined }).apps.allowance()).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  it("shows no count for a plan that includes no apps and has none", async () => {
    fake.plan.apps = 0;
    expect(await made().apps.allowance()).toBeNull();
  });
});

describe("the plan's included apps on a Team Cloud", () => {
  let adas: { key: string; url: string }, team: { key: string; url: string }, bens: { key: string; url: string };
  beforeEach(async () => {
    adas = await publish("mira", join(ownFolder("mira", "ada-chat"), "portfolio"), "Ada's portfolio");
    team = await publish("mira", join(workspace("mira"), "team-site"), "Team site");
    bens = await publish("bens-own", join(workspace("bens-own"), "ledger"), "Ledger");
    messages = { main: [{ role: "bot", text: `The team site is live at ${team.url}` }], "ledger-main": [{ role: "bot", text: bens.url }] };
  });
  const titles = async (auth: RequestAuth) => (await made().apps.list(visibleFor(auth, true), auth)).map((app) => app.title).sort();

  it("shows a member the apps from their own chats and the team's conversations, and the team's count", async () => {
    expect(await titles(session(ADA))).toEqual(["Ada's portfolio", "Ledger", "Team site"]);
    const seen = await made().apps.list(visibleFor(session(ADA), true), session(ADA));
    expect(Object.fromEntries(seen.map((app) => [app.title, app.threadId]))).toEqual({ "Ada's portfolio": "ada-chat", "Team site": "main", Ledger: "ledger-main" });
    expect(await made().apps.allowance()).toEqual({ used: 3, max: 20 });
  });

  it("shows another member, and an admin, nothing from a person's private chat", async () => {
    for (const viewer of [session(BEN), session(OLIVE, true)]) {
      const seen = await made().apps.list(visibleFor(viewer, true), viewer);
      expect(seen.map((app) => app.title).sort()).toEqual(["Ledger", "Team site"]);
      expect(JSON.stringify(seen)).not.toContain(adas.key);
      expect(JSON.stringify(seen)).not.toContain(adas.url);
      expect(await made().apps.lists(visibleFor(viewer, true), viewer, adas.url)).toBe(false);
      expect(await made().apps.remove(visibleFor(viewer, true), viewer, `included-${adas.key}`)).toEqual({ status: 404, body: { error: "No such published app.", code: "gone" } });
    }
    expect(fake.apps.has(adas.key)).toBe(true);
  });

  it("lists an app from a shared folder only where the bot itself wrote its link", async () => {
    const quiet = await publish("mira", join(workspace("mira"), "quiet"), "Quiet");
    messages.main!.push({ role: "user", text: `is ${quiet.url} yours?` });
    expect(await titles(session(BEN))).not.toContain("Quiet");
    messages.main!.push({ role: "bot", text: `Yes: ${quiet.url}` });
    expect(await titles(session(BEN))).toContain("Quiet");
  });

  it("does not let a bot that copies another conversation's record and says its link show a member that app", async () => {
    mkdirSync(join(workspace("bens-own"), "planted"), { recursive: true });
    writeFileSync(join(workspace("bens-own"), "planted", SITE_FILE), readFileSync(join(ownFolder("mira", "ada-chat"), "portfolio", SITE_FILE)));
    messages["ledger-main"]!.push({ role: "bot", text: `Look: ${adas.url}` });
    const seen = await made().apps.list(visibleFor(session(BEN), true), session(BEN));
    expect(seen.map((app) => app.title).sort()).toEqual(["Ledger", "Team site"]);
    expect(JSON.stringify(seen)).not.toContain(adas.key);
    expect((await made().apps.remove(visibleFor(session(BEN), true), session(BEN), `included-${adas.key}`)).status).toBe(404);
    expect(fake.apps.has(adas.key)).toBe(true);
  });

  it("shows nobody on a team an app whose project folder is gone", async () => {
    rmSync(join(workspace("mira"), "team-site"), { recursive: true });
    for (const viewer of [session(ADA), session(BEN), session(OLIVE, true)]) {
      expect(JSON.stringify(await made().apps.list(visibleFor(viewer, true), viewer))).not.toContain(team.key);
      expect((await made().apps.remove(visibleFor(viewer, true), viewer, `included-${team.key}`)).status).toBe(404);
    }
    expect(await made().apps.allowance()).toEqual({ used: 3, max: 20 });
  });

  it("lets a member delete the app from their own private chat", async () => {
    const ada = session(ADA);
    expect((await made().apps.list(visibleFor(ada, true), ada)).find((app) => app.title === "Ada's portfolio")?.canDelete).toBe(true);
    expect((await made().apps.remove(visibleFor(ada, true), ada, `included-${adas.key}`)).status).toBe(200);
    expect(fake.apps.has(adas.key)).toBe(false);
    expect(existsSync(join(ownFolder("mira", "ada-chat"), "portfolio", SITE_FILE))).toBe(false);
  });

  it("refuses a member who only chats with a shared bot for the team's app, and lets the bot's own person and an admin delete", async () => {
    const ben = session(BEN), ada = session(ADA), olive = session(OLIVE, true);
    expect(Object.fromEntries((await made().apps.list(visibleFor(ben, true), ben)).map((app) => [app.title, app.canDelete]))).toEqual({ "Team site": false, Ledger: true });
    expect(await made().apps.remove(visibleFor(ben, true), ben, `included-${team.key}`)).toEqual({ status: 403, body: { error: "This app isn't yours to delete.", code: "forbidden" } });
    expect((await made().apps.remove(visibleFor(ada, true), ada, `included-${bens.key}`)).status).toBe(403);
    expect(fake.apps.size).toBe(3);
    expect((await made().apps.remove(visibleFor(ben, true), ben, `included-${bens.key}`)).status).toBe(200);
    expect((await made().apps.remove(visibleFor(olive, true), olive, `included-${team.key}`)).status).toBe(200);
    expect([...fake.apps.keys()]).toEqual([adas.key]);
  });
});
