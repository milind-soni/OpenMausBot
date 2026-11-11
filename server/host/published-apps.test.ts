import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { SITE_FILE } from "./netlify-sites.ts";
import { createPublishedApps, linkPattern, type PublishedAppsDeps } from "./published-apps.ts";

const ADA = "ada@acme.test", BEN = "ben@acme.test", OLIVE = "olive@acme.test";
const KEYS: Record<string, string> = { [ADA]: "p_adaadaadaadaadaadaada1", [BEN]: "p_benbenbenbenbenbenben1", [OLIVE]: "p_oliveoliveoliveolive01" };
const TOKEN = "nfp_published_apps_host_token_0123456789";

const bots = [
  { id: "mira", name: "Mira", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "ada-chat" }, { threadId: "ben-chat" }] },
  { id: "adas-maus", name: "Ada's MausBot", threadId: "ada-maus-chat", defaultBot: { person: ADA }, tasks: [{ threadId: "ada-maus-chat" }] },
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

const site = (name: string, extra: Record<string, unknown> = {}) => ({
  version: 1, siteId: `id-${name}`, name, url: `https://${name}.netlify.app`, adminUrl: `https://app.netlify.com/projects/${name}`, title: `${name} site`,
  createdAt: "2026-11-10T10:00:00.000Z", publishedAt: "2026-11-10T10:05:00.000Z", access: "public", ...extra,
});
const page = (pageId: string, botId: string, threadId: string, updatedAt: number): PublishedPageRecord => ({
  pageId, url: `https://${pageId}.mausbot.page/`, title: `Page ${pageId.slice(0, 3)}`, botId, source: `/w/${pageId}`, cards: [{ threadId, messageId: `m-${pageId}` }], createdAt: updatedAt, updatedAt,
});
const PAGE_ADA = "adapage0000000000000000", PAGE_TEAM = "teampage000000000000000", PAGE_BEN = "benpage0000000000000000";

let dataDir = "";
let messages: Record<string, Array<{ role: string; text?: string; from?: { botId?: string } }>>;
let pages: PublishedPageRecord[];
let tokenAsks: Array<{ botId: string; email: string }>;
const calls: Array<{ url: string; auth: string | undefined; method: string | undefined }> = [];
let netlifyStatus = 204;
const workspace = (botId: string) => join(dataDir, "workspaces", botId);
const ownFolder = (botId: string, threadId: string) => join(dataDir, "task-workspaces", botId, threadId);
const record = (botId: string, folder: string, value: unknown) => {
  const dir = join(workspace(botId), folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SITE_FILE), JSON.stringify(value));
  return join(dir, SITE_FILE);
};

function apps(over: Partial<PublishedAppsDeps> = {}) {
  return createPublishedApps({
    bots: () => bots, rooms: () => rooms, messages: (threadId) => messages[threadId] ?? [],
    folders: (bot) => [workspace(bot.id), ...[bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)].map((threadId) => ownFolder(bot.id, threadId))],
    ownFolder,
    pages: () => pages,
    unpublishPage: async (pageId) => { pages = pages.filter((one) => one.pageId !== pageId); return { status: 200, text: "Unpublished." }; },
    netlifyToken: (botId, auth) => { tokenAsks.push({ botId, email: emailOf(auth) }); return TOKEN; },
    ownChat: (auth, threadId) => audienceOf(threadId) === `member:${KEYS[emailOf(auth)]}`,
    home: "/nowhere/home", env: {}, now: () => Date.now(),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization, method: init?.method });
      return new Response(netlifyStatus === 204 ? null : `{"message":"${TOKEN}"}`, { status: netlifyStatus });
    }) as typeof fetch,
    ...over,
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "published-apps-host-"));
  record("mira", "adas-shop", site("adas-shop"));
  record("mira", "team-site", site("team-site", { publishedAt: "2026-11-11T09:00:00.000Z", access: "private" }));
  record("mira", "bens-plan", site("bens-plan"));
  record("mira", "room-site", site("room-site"));
  record("adas-maus", "diary", site("adas-diary"));
  messages = {
    "ada-chat": [{ role: "user", text: "publish my shop" }, { role: "bot", text: "Published: https://adas-shop.netlify.app. The link is public." }],
    main: [{ role: "bot", text: "Team site is live at [team-site](https://team-site.netlify.app/)" }],
    "ben-chat": [{ role: "bot", text: "Done: https://bens-plan.netlify.app" }],
    "room-thread": [{ role: "bot", from: { botId: "mira" }, text: "Here: https://room-site.netlify.app/index.html" }],
    "ada-maus-chat": [{ role: "bot", text: "https://adas-diary.netlify.app" }],
  };
  pages = [page(PAGE_ADA, "mira", "ada-chat", 300), page(PAGE_TEAM, "mira", "main", 200), page(PAGE_BEN, "mira", "ben-chat", 100)];
  tokenAsks = [];
  calls.length = 0;
  netlifyStatus = 204;
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const titles = async (auth: RequestAuth, team = true, made = apps()) => (await made.list(visibleFor(auth, team), auth)).map((app) => app.title).sort();
const TEAM_SHARED = ["Page tea", "room-site site", "team-site site"];

describe("the list on a person's own server", () => {
  it("has every bot's Netlify sites and published pages, newest first, each under the bot whose folder or page it is", async () => {
    const listed = await apps().list(visibleFor(OWNER, false), OWNER);
    expect(listed.map((app) => app.title)).toEqual(["team-site site", "adas-shop site", "bens-plan site", "room-site site", "adas-diary site", "Page ada", "Page tea", "Page ben"]
      .sort((a, b) => listed.find((app) => app.title === b)!.publishedAt - listed.find((app) => app.title === a)!.publishedAt));
    expect(listed[0]).toEqual({
      id: "netlify-mira-id-team-site", source: "netlify", title: "team-site site", url: "https://team-site.netlify.app/", bot: { id: "mira", name: "Mira" },
      publishedAt: Date.parse("2026-11-11T09:00:00.000Z"), access: "netlify-team", manageUrl: "https://app.netlify.com/projects/team-site", canDelete: true,
    });
    expect(listed.find((app) => app.id === `page-${PAGE_ADA}`)).toEqual({
      id: `page-${PAGE_ADA}`, source: "page", title: "Page ada", url: `https://${PAGE_ADA}.mausbot.page/`, bot: { id: "mira", name: "Mira" }, threadId: "ada-chat",
      publishedAt: 300, access: "link", canDelete: true,
    });
    expect(listed.every((app) => app.canDelete)).toBe(true);
  });

  it("lists a page whose bot is gone, without a name", async () => {
    pages = [page("orphanpage0000000000000", "deleted-bot", "gone-thread", 5)];
    expect((await apps().list(visibleFor(OWNER, false), OWNER)).find((app) => app.source === "page")?.bot).toEqual({ id: "deleted-bot", name: "" });
  });

  it("puts a record under the bot whose folder holds it, whatever bot the record claims to be", async () => {
    record("adas-maus", "forged", site("forged", { botId: "mira", botName: "Mira" }));
    const forged = (await apps().list(visibleFor(OWNER, false), OWNER)).find((app) => app.title === "forged site")!;
    expect(forged).toMatchObject({ id: "netlify-adas-maus-id-forged", bot: { id: "adas-maus", name: "Ada's MausBot" } });
  });

  it("reads each bot's folders once for requests that come together", async () => {
    const folders = vi.fn((bot: { id: string }) => [workspace(bot.id)]);
    const made = apps({ folders });
    await Promise.all([made.list(visibleFor(OWNER, false), OWNER), made.list(visibleFor(OWNER, false), OWNER), made.lists(visibleFor(OWNER, false), OWNER, "https://adas-shop.netlify.app/")]);
    expect(folders).toHaveBeenCalledTimes(bots.length);
  });

  it("names the conversation whose own folder holds a site's record, so the card opens it", async () => {
    mkdirSync(join(ownFolder("mira", "ada-chat"), "portfolio"), { recursive: true });
    writeFileSync(join(ownFolder("mira", "ada-chat"), "portfolio", SITE_FILE), JSON.stringify(site("portfolio")));
    const listed = await apps().list(visibleFor(OWNER, false), OWNER);
    expect(listed.find((app) => app.title === "portfolio site")?.threadId).toBe("ada-chat");
    expect(listed.find((app) => app.title === "adas-shop site")).not.toHaveProperty("threadId");
  });
});

describe("the list on a Team Cloud", () => {
  it("shows a member what a shared bot published for them and in shared conversations, and their own bot's", async () => {
    expect(await titles(session(ADA))).toEqual(["Page ada", "adas-diary site", "adas-shop site", ...TEAM_SHARED].sort());
  });

  it("shows another member none of that person's private projects", async () => {
    const seen = await apps().list(visibleFor(session(BEN), true), session(BEN));
    expect(seen.map((app) => app.title).sort()).toEqual(["Page ben", "bens-plan site", ...TEAM_SHARED].sort());
    const told = JSON.stringify(seen);
    for (const secret of ["adas-shop", "adas-diary", PAGE_ADA, "ada-chat", "ada-maus-chat", "adas-maus"]) expect(told, secret).not.toContain(secret);
  });

  it("shows an admin what shared bots published in shared conversations, and no member's private project", async () => {
    const seen = await apps().list(visibleFor(session(OLIVE, true), true), session(OLIVE, true));
    expect(seen.map((app) => app.title).sort()).toEqual(TEAM_SHARED);
    expect(JSON.stringify(seen)).not.toMatch(/adas-|bens-|ada-chat|ben-chat|adapage|benpage/);
    expect(seen.every((app) => app.canDelete)).toBe(true);
  });

  it("names the conversation the viewer can read, so the card opens it", async () => {
    const seen = await apps().list(visibleFor(session(ADA), true), session(ADA));
    expect(Object.fromEntries(seen.map((app) => [app.title, app.threadId]))).toEqual({
      "adas-shop site": "ada-chat", "team-site site": "main", "room-site site": "room-thread", "adas-diary site": "ada-maus-chat", "Page ada": "ada-chat", "Page tea": "main",
    });
  });

  it("lists a site only where the bot itself wrote its link: not a person's line, another bot's, a longer address, or no line at all", async () => {
    record("mira", "quiet", site("quiet"));
    record("mira", "typed", site("typed"));
    record("mira", "lookalike", site("shop"));
    messages.main!.push({ role: "user", text: "is https://typed.netlify.app yours?" }, { role: "bot", from: { botId: "other-bot" }, text: "https://typed.netlify.app" },
      { role: "bot", text: "see https://shop.netlify.app.evil.test and https://shop.netlify.application and https://shop.netlify.app-x.test" });
    messages["room-thread"]!.push({ role: "bot", from: { botId: "other-bot" }, text: "https://quiet.netlify.app" }, { role: "bot", text: "https://quiet.netlify.app" });
    const seen = await titles(session(ADA));
    for (const hidden of ["quiet site", "typed site", "shop site"]) expect(seen, hidden).not.toContain(hidden);
  });

  it("keeps a site whose record is in a conversation's own folder to that conversation, whatever any message says", async () => {
    mkdirSync(join(ownFolder("mira", "ada-chat"), "portfolio"), { recursive: true });
    writeFileSync(join(ownFolder("mira", "ada-chat"), "portfolio", SITE_FILE), JSON.stringify(site("portfolio")));
    messages.main!.push({ role: "bot", text: "Ada's is at https://portfolio.netlify.app" });
    messages["ben-chat"]!.push({ role: "bot", text: "https://portfolio.netlify.app" });
    expect(await titles(session(ADA))).toContain("portfolio site");
    expect(await titles(session(BEN))).not.toContain("portfolio site");
    expect(await titles(session(OLIVE, true))).not.toContain("portfolio site");
    const ben = session(BEN);
    expect((await apps().remove(visibleFor(ben, true), ben, "netlify-mira-id-portfolio")).status).toBe(404);
  });

  it("does not let a record planted in a bot's folder show a member someone else's site", async () => {
    record("bens-own", "planted", site("adas-shop", { botId: "mira" }));
    expect(await titles(session(BEN))).not.toContain("adas-shop site");
  });

  it("answers a hostile member's guesses at another person's project as if it did not exist", async () => {
    const made = apps(), ben = session(BEN), visible = () => visibleFor(ben, true);
    for (const id of ["netlify-mira-id-adas-shop", "netlify-adas-maus-id-adas-diary", `page-${PAGE_ADA}`, "netlify-mira-id-missing"]) {
      expect(await made.remove(visible(), ben, id), id).toEqual({ status: 404, body: { error: "No such published app.", code: "gone" } });
    }
    for (const url of ["https://adas-shop.netlify.app/", "https://adas-diary.netlify.app/", `https://${PAGE_ADA}.mausbot.page/`]) expect(await made.lists(visible(), ben, url), url).toBe(false);
    expect(await made.lists(visible(), ben, "https://bens-plan.netlify.app/pricing")).toBe(true);
    expect(calls).toEqual([]);
    expect(tokenAsks).toEqual([]);
    expect(existsSync(join(workspace("mira"), "adas-shop", SITE_FILE))).toBe(true);
    expect(pages).toHaveLength(3);
  });
});

describe("the address in a message", () => {
  it("matches the site's own address and its pages, never a longer host or name", () => {
    const link = linkPattern("https://bright-bakery.netlify.app/");
    for (const text of ["https://bright-bakery.netlify.app", "at https://bright-bakery.netlify.app.", "[site](https://bright-bakery.netlify.app/menu)", "HTTPS://Bright-Bakery.netlify.app/"]) expect(link.test(text), text).toBe(true);
    for (const text of ["https://bright-bakery.netlify.app.evil.test", "https://bright-bakery.netlify.apps", "https://bright-bakery-2.netlify.app", "http://bright-bakery.netlify.app", "bright-bakery.netlify.app"]) expect(link.test(text), text).toBe(false);
    const standIn = linkPattern("http://127.0.0.1:4010/live/abc/");
    expect(standIn.test("http://127.0.0.1:4010/live/abc/index.html")).toBe(true);
    expect(standIn.test("http://127.0.0.1:4010/live/abcd/")).toBe(false);
  });
});

describe("deleting a published app", () => {
  it("deletes the owner's Netlify site with the saved token and removes its record, so the card is gone", async () => {
    const made = apps(), file = join(workspace("mira"), "adas-shop", SITE_FILE);
    expect(await made.remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-adas-shop")).toEqual({ status: 200, body: { ok: true } });
    expect(calls).toEqual([{ url: "https://api.netlify.com/api/v1/sites/id-adas-shop", auth: `Bearer ${TOKEN}`, method: "DELETE" }]);
    expect(existsSync(file)).toBe(false);
    expect((await made.list(visibleFor(OWNER, false), OWNER)).map((app) => app.title)).not.toContain("adas-shop site");
    expect(existsSync(join(workspace("mira"), "team-site", SITE_FILE))).toBe(true);
  });

  it("counts a site Netlify no longer has as deleted", async () => {
    netlifyStatus = 404;
    expect((await apps().remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-adas-shop")).status).toBe(200);
    expect(existsSync(join(workspace("mira"), "adas-shop", SITE_FILE))).toBe(false);
  });

  it("says so and offers Manage on Netlify when no saved token can be used, and deletes nothing", async () => {
    const answer = await apps({ netlifyToken: () => null }).remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-adas-shop");
    expect(answer).toEqual({ status: 409, body: { error: expect.stringContaining("can't be deleted from here"), code: "no_token", manageUrl: "https://app.netlify.com/projects/adas-shop" } });
    expect(calls).toEqual([]);
    expect(existsSync(join(workspace("mira"), "adas-shop", SITE_FILE))).toBe(true);
  });

  it("keeps the record and offers Manage on Netlify when Netlify refuses the token, and says only that it failed otherwise", async () => {
    netlifyStatus = 401;
    expect(await apps().remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-adas-shop")).toMatchObject({ status: 409, body: { code: "token_refused", manageUrl: "https://app.netlify.com/projects/adas-shop" } });
    netlifyStatus = 500;
    expect(await apps().remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-adas-shop")).toEqual({ status: 502, body: { error: "The app could not be deleted. Try again.", code: "failed" } });
    expect(existsSync(join(workspace("mira"), "adas-shop", SITE_FILE))).toBe(true);
  });

  it("never puts the token in an answer or a log line", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logged.push(...args); });
    const answers = [];
    for (const status of [204, 404, 401, 403, 500]) {
      netlifyStatus = status;
      record("mira", "adas-shop", site("adas-shop"));
      answers.push(await apps().remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-adas-shop"));
    }
    answers.push(await apps({ fetch: (async () => { throw new Error(`socket closed sending Bearer ${TOKEN}`); }) as typeof fetch }).remove(visibleFor(OWNER, false), OWNER, "netlify-mira-id-team-site"));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 409, 409, 502, 502]);
    expect(JSON.stringify(answers) + logged.map(String).join("\n")).not.toContain(TOKEN);
  });

  it("lets a member delete what a bot published in their own private chat, with a token asked for as them", async () => {
    const ada = session(ADA);
    expect((await apps().remove(visibleFor(ada, true), ada, "netlify-mira-id-adas-shop")).status).toBe(200);
    expect(tokenAsks).toEqual([{ botId: "mira", email: ADA }]);
    expect((await apps().remove(visibleFor(ada, true), ada, `page-${PAGE_ADA}`)).status).toBe(200);
    expect(pages.map((one) => one.pageId)).toEqual([PAGE_TEAM, PAGE_BEN]);
  });

  it("refuses a member who only chats with a shared bot for what it published in a shared conversation", async () => {
    const ben = session(BEN), made = apps();
    const shared = (await made.list(visibleFor(ben, true), ben)).filter((app) => TEAM_SHARED.includes(app.title));
    expect(shared.map((app) => app.canDelete)).toEqual([false, false, false]);
    for (const id of ["netlify-mira-id-team-site", `page-${PAGE_TEAM}`]) {
      expect(await made.remove(visibleFor(ben, true), ben, id), id).toEqual({ status: 403, body: { error: "This app isn't yours to delete.", code: "forbidden" } });
    }
    expect(calls).toEqual([]);
    expect(tokenAsks).toEqual([]);
    expect(pages).toHaveLength(3);
  });

  it("lets the person a bot belongs to delete what it published", async () => {
    record("bens-own", "ledger", site("ledger"));
    messages["ledger-main"] = [{ role: "bot", text: "https://ledger.netlify.app" }];
    const ben = session(BEN), ada = session(ADA), made = apps();
    expect((await made.list(visibleFor(ada, true), ada)).find((app) => app.title === "ledger site")?.canDelete).toBe(false);
    expect((await made.remove(visibleFor(ben, true), ben, "netlify-bens-own-id-ledger")).status).toBe(200);
  });

  it("lets an admin delete a shared bot's app from a shared conversation, with a token asked for as the admin", async () => {
    const olive = session(OLIVE, true), made = apps();
    expect((await made.remove(visibleFor(olive, true), olive, "netlify-mira-id-team-site")).status).toBe(200);
    expect(tokenAsks).toEqual([{ botId: "mira", email: OLIVE }]);
    expect(calls).toHaveLength(1);
    expect((await made.remove(visibleFor(olive, true), olive, `page-${PAGE_TEAM}`)).status).toBe(200);
    expect((await made.remove(visibleFor(olive, true), olive, "netlify-mira-id-adas-shop")).status).toBe(404);
    expect((await made.remove(visibleFor(olive, true), olive, `page-${PAGE_ADA}`)).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("says a page could not be deleted when the pages service refuses", async () => {
    const answer = await apps({ unpublishPage: async () => ({ status: 502, text: "The pages service did not answer." }) }).remove(visibleFor(OWNER, false), OWNER, `page-${PAGE_TEAM}`);
    expect(answer).toEqual({ status: 502, body: { error: "The app could not be deleted. Try again.", code: "failed" } });
  });
});
