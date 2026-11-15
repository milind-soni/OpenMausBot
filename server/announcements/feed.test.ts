import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ANNOUNCEMENTS_URL, type AnnouncementFeed } from "../../shared/announcements.ts";
import {
  ANNOUNCEMENTS_DISABLE_ENV, ANNOUNCEMENTS_RETRY_MS, ANNOUNCEMENTS_TTL_MS, AnnouncementStore, announcementsCachePath, BUNDLED_ANNOUNCEMENTS,
} from "./feed.ts";

const NOW = Date.parse("2026-12-01T10:00:00Z");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-announcements-")); scratch.push(dir); return dir; };
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "product", title: "Title", body: "Body.", primary: { label: "Open", action: { open_url: "https://example.com/" } }, ends: "2026-12-31T00:00:00Z", ...extra,
});
const feed = (updatedAt: string, cards: unknown[]): AnnouncementFeed => ({ version: 1, updatedAt, cards: cards as AnnouncementFeed["cards"] });
const bundled = feed("2026-11-01T00:00:00Z", []);
const answer = (body: unknown, init: ResponseInit = { status: 200 }) => new Response(typeof body === "string" ? body : JSON.stringify(body), init);

function subject(options: { fetch?: typeof fetch; dir?: string; env?: NodeJS.ProcessEnv; bundled?: AnnouncementFeed } = {}) {
  let time = NOW;
  const log = vi.fn();
  const store = new AnnouncementStore({ dataDir: options.dir ?? dataDir(), bundled: options.bundled ?? bundled, now: () => time, log, env: options.env ?? {}, fetch: options.fetch });
  return { store, log, advance: (ms: number) => { time += ms; } };
}

it("bundles the repository's file, and never fetches while switched off", async () => {
  expect(BUNDLED_ANNOUNCEMENTS.version).toBe(1);
  const fetchMock = vi.fn();
  const { store } = subject({ fetch: fetchMock, env: { [ANNOUNCEMENTS_DISABLE_ENV]: "1" }, bundled: feed("2026-11-01T00:00:00Z", [card("bundled-card")]) });
  expect(await store.cardsForPage()).toEqual([]);
  await store.refresh({ force: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(store.disabled).toBe(true);
});

it("tests never reach the network: the suite switches it off for every server it starts", () => {
  expect(process.env[ANNOUNCEMENTS_DISABLE_ENV]).toBe("1");
});

describe("downloading the file", () => {
  it("asks main's raw file with a plain GET, nothing of the person's sent, and keeps what it got", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => answer(feed("2026-12-01T09:00:00Z", [card("phone-app")])));
    const dir = dataDir();
    const { store } = subject({ fetch: fetchMock as unknown as typeof fetch, dir });
    expect((await store.cardsForPage()).map((entry) => entry.id)).toEqual(["phone-app"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ANNOUNCEMENTS_URL);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(Object.keys(init!.headers as Record<string, string>).sort()).toEqual(["accept", "user-agent"]);
    expect(url).not.toMatch(/[?#]/);
    expect(existsSync(announcementsCachePath(dir))).toBe(true);
    // A later start reads the copy on disk before any download.
    expect(subject({ dir, fetch: vi.fn() }).store.cards().map((entry) => entry.id)).toEqual(["phone-app"]);
  });

  it("fetches at most hourly, however many pages ask", async () => {
    const fetchMock = vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", [])));
    const { store, advance } = subject({ fetch: fetchMock as unknown as typeof fetch });
    await Promise.all([store.cardsForPage(), store.cardsForPage(), store.cardsForPage()]);
    advance(ANNOUNCEMENTS_TTL_MS - 1000);
    await store.cardsForPage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(2000);
    await store.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offline, rate-limited, too large, slow or not JSON: keeps the last good copy, says nothing to the page, retries later", async () => {
    const dir = dataDir();
    mkdirSync(dirname(announcementsCachePath(dir)), { recursive: true });
    writeFileSync(announcementsCachePath(dir), JSON.stringify({ fetchedAtMs: NOW - ANNOUNCEMENTS_TTL_MS * 2, feed: feed("2026-11-20T00:00:00Z", [card("kept")]) }));
    const failures: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => answer("rate limited", { status: 429 }),
      async () => answer("x".repeat(70 * 1024)),
      async () => answer("<html>"),
      async () => answer({ version: 2, updatedAt: "2026-12-01T00:00:00Z", cards: [] }),
    ];
    for (const failure of failures) {
      const { store, log } = subject({ dir, fetch: vi.fn(failure) as unknown as typeof fetch });
      expect((await store.cardsForPage()).map((entry) => entry.id), "the page is not kept waiting on a copy it has").toEqual(["kept"]);
      await store.refresh();
      expect(store.cards().map((entry) => entry.id)).toEqual(["kept"]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/keeping the current copy/));
    }
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    const { store, advance } = subject({ dir, fetch: fetchMock as unknown as typeof fetch });
    await store.refresh();
    await store.refresh();
    expect(fetchMock, "backs off after a failure").toHaveBeenCalledTimes(1);
    advance(ANNOUNCEMENTS_RETRY_MS + 1);
    await store.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a page's first ask waits a moment for the first download, never longer", async () => {
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const { store } = subject({ fetch: hanging as unknown as typeof fetch });
    const started = Date.now();
    expect(await store.cardsForPage(50)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an older copy from GitHub's cache cannot bring back a card a newer one removed", async () => {
    const dir = dataDir();
    const newer = subject({ dir, fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", []))) as unknown as typeof fetch });
    await newer.store.refresh();
    const stale = subject({ dir, fetch: vi.fn(async () => answer(feed("2026-11-30T00:00:00Z", [card("pulled-back")]))) as unknown as typeof fetch });
    expect(await stale.store.cardsForPage()).toEqual([]);
    expect(JSON.parse(readFileSync(announcementsCachePath(dir), "utf8")).feed.updatedAt).toBe("2026-12-01T09:00:00Z");
  });

  it("skips a card it cannot read and one whose time has passed, and shows the rest", async () => {
    const cards = [card("good"), card("bad", { primary: { label: "Go", action: { run: "x" } } }), card("over", { ends: "2026-11-30T00:00:00Z" })];
    const { store, log } = subject({ fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", cards))) as unknown as typeof fetch });
    expect((await store.cardsForPage()).map((entry) => entry.id)).toEqual(["good"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipping cards\.1/));
  });
});

describe("GET /api/announcements", () => {
  it("answers with the cards, and is open to every signed-in page", async () => {
    const { announcementRoutes, ANNOUNCEMENTS_PATH } = await import("../routes/announcements.ts");
    const { PASS } = await import("../routes/table.ts");
    const { requiredScope } = await import("../request-auth.ts");
    const sent: Array<{ status: number; body: unknown }> = [];
    const json = ((_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); }) as never;
    const context = (method: string, path: string) => ({ req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth: {} as never, json, readBody: (async () => ({})) as never });
    expect(await announcementRoutes(context("GET", "/api/other"))).toBe(PASS);
    await announcementRoutes(context("GET", ANNOUNCEMENTS_PATH));
    expect(sent[0]).toEqual({ status: 200, body: { cards: [], disabled: true } });
    await announcementRoutes(context("POST", ANNOUNCEMENTS_PATH));
    expect(sent[1]!.status).toBe(405);
    expect(requiredScope("GET", ANNOUNCEMENTS_PATH)).toBe("client");
    expect(requiredScope("POST", ANNOUNCEMENTS_PATH)).toBe("admin");
  });
});
