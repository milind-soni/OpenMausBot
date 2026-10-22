import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublishedPageCard } from "../../shared/published-page.ts";
import { FAKE_DESKTOP_TOKEN, FAKE_HOME, FAKE_TOKEN_URL, fakePagesService } from "../testing/fake-pages.ts";
import { applyIncludedPagesMessage, pagesHomeSignature } from "./access.ts";
import { PageBundleError, readPageBundle } from "./bundle.ts";
import { PublishedPagesStore } from "./store.ts";
import { createPublishedPages } from "./service.ts";

const SITE = { "index.html": "<!doctype html><h1>Bake sale</h1>", "style.css": "h1{color:red}" };
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-pages-")); });
afterEach(() => {
  applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: null });
  rmSync(dir, { recursive: true, force: true });
});

function writeSite(folder: string, files: Record<string, string> = SITE) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}
const signIn = () => applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: { url: FAKE_TOKEN_URL, token: FAKE_DESKTOP_TOKEN } });

function setup(options: { home?: boolean; quota?: number } = {}) {
  const service = fakePagesService({ quota: options.quota });
  const work = join(dir, "work"), data = join(dir, "data");
  mkdirSync(work, { recursive: true });
  const cards: Array<{ threadId: string; id: string; text: string; card: PublishedPageCard }> = [];
  let ids = 0;
  const pages = createPublishedPages({ dataDir: data, cloudHome: options.home ? FAKE_HOME : null, fetch: service.fetch,
    patch: (threadId, messageId, text, card) => { const shown = cards.find((each) => each.id === messageId && each.threadId === threadId); if (shown) Object.assign(shown, { text, card }); } });
  const post = (threadId: string) => (text: string, card: PublishedPageCard) => { const id = `m${++ids}`; cards.push({ threadId, id, text, card }); return id; };
  const publish = (input: { path: string; title?: string; pageId?: string; botId?: string; threadId?: string }) => pages.publisher.publish({
    botId: input.botId ?? "bot-1", threadId: input.threadId ?? "thread-1", path: input.path, title: input.title ?? "Bake sale",
    ...(input.pageId ? { pageId: input.pageId } : {}), roots: [work], post: post(input.threadId ?? "thread-1") });
  return { service, pages, work, data, cards, publish };
}

describe("publishing a page", () => {
  it("asks the person to sign in to MausBot when this app has no account, and publishes nothing", async () => {
    const f = setup();
    writeSite(join(f.work, "site"));
    const outcome = await f.publish({ path: "site" });
    expect(outcome).toEqual({ status: 403, text: "Publishing a page needs a MausBot account. Sign in to MausBot in the app's Settings, then ask again." });
    expect(f.service.minted).toEqual([]);
    expect(f.cards).toEqual([]);
  });

  it("says publishing isn't turned on yet, never \"sign in\", when this signed-in desktop's Admin offers no pages", async () => {
    const f = setup();
    applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: null, offered: false });
    writeSite(join(f.work, "site"));
    const outcome = await f.publish({ path: "site" });
    expect(outcome.text).toBe("Publishing pages isn't turned on for this account yet.");
    expect(f.service.minted).toEqual([]);
    expect(f.cards).toEqual([]);
    applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: null });
    expect((await f.publish({ path: "site" })).text).toMatch(/^Publishing a page needs a MausBot account/u);
  });

  it("publishes a folder to a new link with a card showing the link and the usage, and remembers it", async () => {
    const f = setup();
    signIn();
    writeSite(join(f.work, "site"));
    const outcome = await f.publish({ path: "site" });
    expect(outcome.status).toBe(200);
    const [page] = [...f.service.pages.keys()];
    const url = `https://${page}.mausbot.page/`;
    expect(outcome.text).toContain(`Published “Bake sale” at ${url}`);
    expect(outcome.text).toContain("This account now has 1 of 5 pages.");
    expect(outcome.text).toContain("Free pages carry a small “Made with MausBot” badge.");
    expect(f.cards).toEqual([{ threadId: "thread-1", id: "m1", text: `Published “Bake sale”: ${url} (1 of 5 pages)`,
      card: { state: "live", title: "Bake sale", pageId: page, url, usage: { pages: 1, limit: 5 } } }]);
    expect(Object.fromEntries(f.service.pages.get(page!)!.files)).toEqual(SITE);
    expect(new PublishedPagesStore(join(f.data, "published-pages.json")).get(page!)).toMatchObject({ url, title: "Bake sale", botId: "bot-1",
      cards: [{ threadId: "thread-1", messageId: "m1" }] });
  });

  it("republishes the same folder to the same link, also from a new conversation, and with an explicit page id", async () => {
    const f = setup();
    signIn();
    const site = writeSite(join(f.work, "site"));
    await f.publish({ path: "site" });
    writeFileSync(join(site, "index.html"), "<h1>Tomorrow's menu</h1>");
    const again = await f.publish({ path: join(site), threadId: "routine-run-2" });
    const [page] = [...f.service.pages.keys()];
    expect(again.text).toContain(`Updated “Bake sale” at the same link: https://${page}.mausbot.page/`);
    expect(f.service.minted.map((call) => call.action)).toEqual(["create", "update"]);
    expect(f.service.pages.size).toBe(1);
    expect(f.service.pages.get(page!)!.files.get("index.html")).toBe("<h1>Tomorrow's menu</h1>");
    writeSite(join(f.work, "other"), { "index.html": "<p>Other</p>" });
    // A page id from the link updates that page even when this app didn't publish it (the same account elsewhere).
    f.pages.store.forget(page!);
    await f.publish({ path: "other", pageId: page });
    expect(f.service.minted.at(-1)).toEqual({ action: "update", pageId: page, caller: "desktop" });
    expect(f.service.pages.get(page!)!.files.get("index.html")).toBe("<p>Other</p>");
    expect(f.cards.map((card) => card.card.url)).toEqual(Array(3).fill(`https://${page}.mausbot.page/`));
  });

  it("gives a folder whose page was unpublished elsewhere a new link instead of failing", async () => {
    const f = setup();
    signIn();
    writeSite(join(f.work, "site"));
    await f.publish({ path: "site" });
    const [first] = [...f.service.pages.keys()];
    f.service.pages.delete(first!);
    const again = await f.publish({ path: "site" });
    expect(again.status).toBe(200);
    expect([...f.service.pages.keys()]).toHaveLength(1);
    expect([...f.service.pages.keys()][0]).not.toBe(first);
  });

  it("at the plan's limit, says so for the bot to pass on and shows a card offering more pages, with the usage", async () => {
    const f = setup({ quota: 1 });
    signIn();
    writeSite(join(f.work, "one"));
    writeSite(join(f.work, "two"));
    await f.publish({ path: "one" });
    const refused = await f.publish({ path: "two", title: "Second" });
    expect(refused.status).toBe(402);
    expect(refused.text).toBe("You’ve used your 1 free pages. MausBot Cloud gives you more, and pages without the badge. Tell the person this in your reply.");
    expect(f.cards.at(-1)).toMatchObject({ text: "You’ve used your 1 free pages. MausBot Cloud gives you more, and pages without the badge.",
      card: { state: "limit", title: "Second", upgrade: true, plan: "free", usage: { pages: 1, limit: 1 } } });
  });

  it("publishes as a Cloud home with a request signed by its bootstrap secret", async () => {
    const f = setup({ home: true });
    writeSite(join(f.work, "site"));
    expect((await f.publish({ path: "site" })).status).toBe(200);
    expect(f.service.minted).toEqual([{ action: "create", caller: "home" }]);
  });

  it("refuses a missing path, a path outside the working folder, a single file that isn't a page, and a folder without index.html", async () => {
    const f = setup();
    signIn();
    expect(await f.publish({ path: "nowhere" })).toMatchObject({ status: 404 });
    const outside = writeSite(join(dir, "outside"));
    expect(await f.publish({ path: outside })).toMatchObject({ status: 403, text: expect.stringContaining("working folder") });
    writeFileSync(join(f.work, "notes.md"), "# hi");
    expect(await f.publish({ path: "notes.md" })).toMatchObject({ status: 400, text: expect.stringContaining(".html") });
    writeSite(join(f.work, "noindex"), { "home.html": "<p>hi</p>" });
    expect(await f.publish({ path: "noindex" })).toMatchObject({ status: 400, text: expect.stringContaining("index.html") });
    expect(await f.publish({ path: "notes.md", title: "  " })).toMatchObject({ status: 400 });
    expect(f.service.minted).toEqual([]);
  });

  it("publishes a single .html file as the page, and leaves out hidden files, server code and links out of the folder", async () => {
    const f = setup();
    signIn();
    writeFileSync(join(f.work, "card.html"), "<p>Card</p>");
    await f.publish({ path: "card.html", title: "Card" });
    const [single] = [...f.service.pages.values()];
    expect(Object.fromEntries(single!.files)).toEqual({ "index.html": "<p>Card</p>" });
    const site = writeSite(join(f.work, "site"), { ...SITE, ".env": "SECRET=1", ".git/config": "x", "app.py": "print()", "node_modules/a.js": "x", "img/logo.svg": "<svg/>" });
    writeFileSync(join(dir, "secret.txt"), "outside");
    symlinkSync(join(dir, "secret.txt"), join(site, "linked.txt"));
    const outcome = await f.publish({ path: "site" });
    expect(outcome.text).toContain("Left out 2 files a page can't serve: app.py, node_modules/");
    const published = [...f.service.pages.values()][1]!;
    expect([...published.files.keys()].sort()).toEqual(["img/logo.svg", "index.html", "style.css"]);
  });

  it("publishes a dashboard's csv, parquet and arrow data with it, and leaves out a wasm file", async () => {
    const f = setup();
    signIn();
    writeSite(join(f.work, "dash"), { "index.html": "<p>Sales</p>", "data.parquet": "PAR1", "data/backup.csv": "a\n1\n", "data/live.arrow": "ARROW1", "duckdb.wasm": "x" });
    const outcome = await f.publish({ path: "dash" });
    expect(outcome.text).toContain("Left out 1 file a page can't serve: duckdb.wasm");
    const [published] = [...f.service.pages.values()];
    expect([...published!.files.keys()].sort()).toEqual(["data.parquet", "data/backup.csv", "data/live.arrow", "index.html"]);
  });

  it("refuses a folder over a page's bytes or files before asking for a token", async () => {
    const f = setup();
    signIn();
    const site = writeSite(join(f.work, "big"), { "index.html": "x".repeat(2000), "a.css": "a", "b.css": "b" });
    await expect(readPageBundle(site, [f.work], { bytes: 1000, files: 200 })).rejects.toThrow(PageBundleError);
    await expect(readPageBundle(site, [f.work], { bytes: 5000, files: 2 })).rejects.toThrow(/more than 2 files/);
    expect((await readPageBundle(site, [f.work], { bytes: 5000, files: 3 })).files).toHaveLength(3);
    writeFileSync(join(site, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(await f.publish({ path: "big" })).toMatchObject({ status: 413 });
    expect(f.service.minted).toEqual([]);
  });

  it("says plainly when publishing can't be reached", async () => {
    const f = setup();
    signIn();
    writeSite(join(f.work, "site"));
    f.service.state.down = true;
    expect(await f.publish({ path: "site" })).toEqual({ status: 503, text: "Publishing isn't available right now. Try again in a few minutes." });
  });
});

describe("unpublishing a page", () => {
  it("takes it down by id or by the folder it came from, and marks every card that showed it", async () => {
    const f = setup();
    signIn();
    writeSite(join(f.work, "site"));
    writeSite(join(f.work, "menu"));
    await f.publish({ path: "site" });
    await f.publish({ path: "site", threadId: "thread-2" });
    await f.publish({ path: "menu", title: "Menu" });
    const [site, menu] = [...f.service.pages.keys()];
    const outcome = await f.pages.publisher.unpublish({ pageId: site });
    expect(outcome).toMatchObject({ status: 200, text: "Unpublished “Bake sale”. Its link no longer opens.", card: { state: "unpublished", usage: { pages: 1, limit: 5 } } });
    expect(f.cards.filter((card) => card.card.pageId === site).map((card) => [card.threadId, card.card.state, card.text])).toEqual([
      ["thread-1", "unpublished", "Unpublished “Bake sale”. Its link no longer opens."], ["thread-2", "unpublished", "Unpublished “Bake sale”. Its link no longer opens."]]);
    const byPath = await f.pages.publisher.unpublish({ path: "menu", botId: "bot-1", roots: [f.work] });
    expect(byPath.status).toBe(200);
    expect(f.service.pages.has(menu!)).toBe(false);
    expect(await f.pages.publisher.unpublish({ path: "menu", botId: "bot-1", roots: [f.work] })).toMatchObject({ status: 404 });
    expect(await f.pages.publisher.unpublish({ pageId: "NOT-AN-ID" })).toMatchObject({ status: 400 });
    expect(await f.pages.publisher.unpublish({})).toMatchObject({ status: 400 });
  });

  it("forgets a page that is already gone", async () => {
    const f = setup();
    signIn();
    writeSite(join(f.work, "site"));
    await f.publish({ path: "site" });
    const [page] = [...f.service.pages.keys()];
    f.service.pages.delete(page!);
    expect(await f.pages.publisher.unpublish({ pageId: page })).toMatchObject({ status: 200, text: "That page was already taken down.", card: { state: "unpublished" } });
    expect(f.pages.store.get(page!)).toBeNull();
  });
});

describe("pages access", () => {
  it("takes only a well-formed pages token for the Admin over https from the desktop", () => {
    expect(applyIncludedPagesMessage({ type: "openmausbot:included-x", access: null })).toBe(false);
    expect(() => applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: { url: "http://cloud.example.test/x", token: FAKE_DESKTOP_TOKEN } })).toThrow();
    expect(() => applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: { url: FAKE_TOKEN_URL, token: "omb_xd_short" } })).toThrow();
    expect(applyIncludedPagesMessage({ type: "openmausbot:included-pages", access: { url: FAKE_TOKEN_URL, token: FAKE_DESKTOP_TOKEN } })).toBe(true);
  });

  it("signs a home's request exactly as the Admin checks it", () => {
    // The same vector is pinned in openmaus-cloud tests/cloud-pages.test.ts.
    expect(pagesHomeSignature("s".repeat(43), "cm-test-home", "1792670400", "nonce-nonce-nonce-1", '{"action":"create"}')).toBe("smys7kDYS99REKsdwsd9OaXv6pH_hP1Wajaq3KrTiVo");
  });
});
