import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compareVersions } from "../../shared/announcements.ts";
import { RELEASES_URL, type ReleaseFeed } from "../../shared/release-notes.ts";
import { ANNOUNCEMENTS_DISABLE_ENV } from "./remote-file.ts";
import { BUNDLED_RELEASES, ReleaseNotesStore, releasesCachePath, RELEASES_MAX_BYTES } from "./release-notes.ts";

const NOW = Date.parse("2026-12-01T10:00:00Z");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "omb-release-notes-")); scratch.push(dir); return dir; };
const release = (version: string, items: string[] = ["**Faster.** Much."]) => ({ version, date: "2026-11-30T00:00:00Z", sections: [{ title: "Fixes", items }] });
const feed = (updatedAt: string, releases: unknown[]) => ({ version: 1, updatedAt, releases }) as ReleaseFeed;
const answer = (body: unknown, init: ResponseInit = { status: 200 }) => new Response(typeof body === "string" ? body : JSON.stringify(body), init);

function subject(options: { fetch?: typeof fetch; dir?: string; env?: NodeJS.ProcessEnv } = {}) {
  const log = vi.fn();
  const store = new ReleaseNotesStore({ dataDir: options.dir ?? dataDir(), bundled: feed("2026-11-01T00:00:00Z", [release("0.1.1")]), now: () => NOW, log, env: options.env ?? {}, fetch: options.fetch });
  return { store, log };
}

it("bundles the repository's file: newest first, at most twenty, and well under the size an install reads", () => {
  expect(BUNDLED_RELEASES.releases.length).toBeGreaterThan(0);
  expect(BUNDLED_RELEASES.releases.length).toBeLessThanOrEqual(20);
  const versions = BUNDLED_RELEASES.releases.map((entry) => entry.version);
  expect([...versions].sort((a, b) => compareVersions(b, a) ?? 0)).toEqual(versions);
  expect(Buffer.byteLength(JSON.stringify(BUNDLED_RELEASES))).toBeLessThan(RELEASES_MAX_BYTES);
});

describe("the release notes store", () => {
  it("downloads main's raw file with the announcements' plain GET, caches it, and a later start reads the cache", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => answer(feed("2026-12-01T09:00:00Z", [release("0.1.2"), release("0.1.1")])));
    const dir = dataDir();
    const { store } = subject({ fetch: fetchMock as unknown as typeof fetch, dir });
    await store.ready();
    expect(store.releases().map((entry) => entry.version)).toEqual(["0.1.2", "0.1.1"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(RELEASES_URL);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(existsSync(releasesCachePath(dir))).toBe(true);
    expect(subject({ dir, fetch: vi.fn() }).store.releases().map((entry) => entry.version)).toEqual(["0.1.2", "0.1.1"]);
  });

  it("skips a release with markup in a line, and keeps the last good copy when the download is too large or not the file", async () => {
    const hostile = subject({ fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", [release("0.1.9", ["<img src=x onerror=alert(1)>"]), release("0.1.8")]))) as unknown as typeof fetch });
    await hostile.store.ready();
    expect(hostile.store.releases().map((entry) => entry.version)).toEqual(["0.1.8"]);
    expect(hostile.log).toHaveBeenCalledWith(expect.stringMatching(/skipping releases\.0/));
    for (const bad of [async () => answer("x".repeat(RELEASES_MAX_BYTES + 1)), async () => answer({ version: 1, updatedAt: "2026-12-01T09:00:00Z", cards: [] })]) {
      const { store, log } = subject({ fetch: vi.fn(bad) as unknown as typeof fetch });
      await store.ready();
      expect(store.releases().map((entry) => entry.version)).toEqual(["0.1.1"]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/keeping the current copy/));
    }
  });

  it("shows nothing and never downloads while announcements are switched off", async () => {
    const fetchMock = vi.fn();
    const { store } = subject({ fetch: fetchMock, env: { [ANNOUNCEMENTS_DISABLE_ENV]: "1" } });
    await store.ready();
    await store.refresh({ force: true });
    expect(store.releases()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
