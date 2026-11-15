// The announcements feed, as the model manifest (server/model-manifest/manifest.ts) keeps its list: a copy bundled with
// this release, a disk cache of the last good download, and a download from main on raw.githubusercontent.com. The
// fetch, cache and failure handling follow that file line for line; the two should become one helper once both are on
// main. Unlike the manifest it never runs on a timer of its own: a page asks for the cards at launch and about hourly
// (src/lib/announcements.ts), and that ask refreshes the copy here when it is an hour old, so a server nobody opens never
// downloads it. The request is a plain anonymous GET: no cookie, no id, no version.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import bundledFeedJson from "../../announcements/announcements.json" with { type: "json" };
import { ANNOUNCEMENTS_URL, liveCards, parseAnnouncementFeed, type AnnouncementCard, type AnnouncementFeed } from "../../shared/announcements.ts";
import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

/** "1" stops the download and every remote card on this server's pages, the bundled ones included. */
export const ANNOUNCEMENTS_DISABLE_ENV = "OMB_DISABLE_ANNOUNCEMENTS";
export const ANNOUNCEMENTS_TTL_MS = 60 * 60 * 1000;
/** Back off failed fetches, so an offline computer does not try on every page load. */
export const ANNOUNCEMENTS_RETRY_MS = 5 * 60 * 1000;
export const ANNOUNCEMENTS_FETCH_TIMEOUT_MS = 10_000;
export const ANNOUNCEMENTS_MAX_BYTES = 64 * 1024;
/** How long a page's ask waits for a first download when there is no copy on disk yet; after that it gets what is here. */
export const ANNOUNCEMENTS_FIRST_WAIT_MS = 3_000;

const parsedBundle = parseAnnouncementFeed(bundledFeedJson, { strict: true, nowMs: Number.MAX_SAFE_INTEGER / 2 });
if (!parsedBundle.ok) throw new Error(`The bundled announcements are invalid (${parsedBundle.error})`);
export const BUNDLED_ANNOUNCEMENTS: AnnouncementFeed = parsedBundle.feed;

/** Under providers/, as the manifest's cache is, so backups and Move to Cloud leave it out. */
export function announcementsCachePath(dataDir: string): string {
  return join(dataDir, "providers", "announcements", "announcements.json");
}

export interface AnnouncementStoreOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  bundled?: AnnouncementFeed;
  timeoutMs?: number;
  maxBytes?: number;
  log?: (message: string) => void;
}

const updatedAtMs = (feed: AnnouncementFeed) => Date.parse(feed.updatedAt);

export class AnnouncementStore {
  private readonly options: AnnouncementStoreOptions;
  private readonly cachePath: string;
  private feed: AnnouncementFeed;
  private fetchedAtMs: number | null = null;
  private lastAttemptMs: number | null = null;
  private diskChecked = false;
  private inflight: Promise<AnnouncementFeed> | undefined;

  constructor(options: AnnouncementStoreOptions) {
    this.options = options;
    this.feed = options.bundled ?? BUNDLED_ANNOUNCEMENTS;
    this.cachePath = announcementsCachePath(options.dataDir);
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(text: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(`[announcements] ${text}`);
  }

  get disabled(): boolean {
    return (this.options.env ?? process.env)[ANNOUNCEMENTS_DISABLE_ENV] === "1";
  }

  /** The newest usable copy. Reads the disk cache once and never waits on the network. */
  current(): AnnouncementFeed {
    if (!this.diskChecked) this.loadDiskCache();
    return this.feed;
  }

  /** What a page is handed: nothing when switched off, else the cards whose time has not passed. */
  cards(): AnnouncementCard[] {
    return this.disabled ? [] : liveCards(this.current().cards, this.now);
  }

  /** Skipped inside `ttlMs` of the last good fetch and for a while after a failed one, unless `force`. Concurrent calls
   * share one request. Never throws. */
  refresh(options: { force?: boolean; ttlMs?: number } = {}): Promise<AnnouncementFeed> {
    if (this.disabled) return Promise.resolve(this.current());
    this.inflight ??= this.fetchAndStore(Boolean(options.force), options.ttlMs ?? ANNOUNCEMENTS_TTL_MS).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** A page's ask: the cards now, after waiting a moment for a first download only when nothing was ever fetched. */
  async cardsForPage(firstWaitMs = ANNOUNCEMENTS_FIRST_WAIT_MS): Promise<AnnouncementCard[]> {
    if (this.disabled) return [];
    this.current();
    const refreshing = this.refresh().catch(() => this.feed);
    if (this.fetchedAtMs === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([refreshing, new Promise((resolve) => { timer = setTimeout(resolve, firstWaitMs); timer.unref?.(); })]);
      clearTimeout(timer);
    }
    return this.cards();
  }

  private get maxBytes(): number {
    return this.options.maxBytes ?? ANNOUNCEMENTS_MAX_BYTES;
  }

  private loadDiskCache(): void {
    this.diskChecked = true;
    try {
      if (!existsSync(this.cachePath) || statSync(this.cachePath).size > this.maxBytes * 2) return;
      const raw = JSON.parse(readFileSync(this.cachePath, "utf8")) as { fetchedAtMs?: unknown; feed?: unknown };
      const parsed = parseAnnouncementFeed(raw.feed, { nowMs: this.now });
      if (!parsed.ok) {
        this.log(`ignoring the cached copy (${parsed.error})`);
        return;
      }
      if (updatedAtMs(this.feed) > updatedAtMs(parsed.feed)) return;
      this.feed = parsed.feed;
      this.fetchedAtMs = typeof raw.fetchedAtMs === "number" && Number.isFinite(raw.fetchedAtMs) ? raw.fetchedAtMs : null;
    } catch (error) {
      this.log(`could not read the cached copy (${message(error)})`);
    }
  }

  private async fetchAndStore(force: boolean, ttlMs: number): Promise<AnnouncementFeed> {
    this.current();
    const now = this.now;
    // Expire timestamps from the future after a clock rollback; the cache crosses restarts, so no monotonic clock.
    const within = (sinceMs: number | null, windowMs: number) => sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (!force && within(this.fetchedAtMs, ttlMs)) return this.feed;
    if (!force && within(this.lastAttemptMs, ANNOUNCEMENTS_RETRY_MS)) return this.feed;
    this.lastAttemptMs = now;

    let fetched: AnnouncementFeed;
    try {
      const result = await this.download();
      fetched = result.feed;
      for (const skipped of result.skipped) this.log(`skipping ${skipped}`);
    } catch (error) {
      this.log(`could not refresh the announcements (${message(error)}); keeping the current copy`);
      return this.feed;
    }
    // A stale CDN copy loses to what we already have, so it cannot bring back a card a newer copy removed.
    if (updatedAtMs(fetched) < updatedAtMs(this.feed)) {
      this.log(`ignoring a downloaded copy older than the current one (${fetched.updatedAt})`);
      return this.feed;
    }
    this.feed = fetched;
    this.fetchedAtMs = now;
    this.lastAttemptMs = null;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileAtomic(this.cachePath, JSON.stringify({ fetchedAtMs: now, feed: fetched }));
    } catch (error) {
      this.log(`could not save the downloaded announcements (${message(error)})`);
    }
    return this.feed;
  }

  private async download(): Promise<{ feed: AnnouncementFeed; skipped: string[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? ANNOUNCEMENTS_FETCH_TIMEOUT_MS);
    try {
      const response = await (this.options.fetch ?? fetch)(ANNOUNCEMENTS_URL, {
        headers: { accept: "application/json", "user-agent": "OpenMausBot" },
        // Nothing of the person's goes with it.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        // raw.githubusercontent.com answers directly; anywhere else is not the file we meant to read.
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`larger than ${this.maxBytes} bytes`);
      }
      const text = await readCapped(response, this.maxBytes);
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
      const parsed = parseAnnouncementFeed(json, { nowMs: this.now });
      if (!parsed.ok) throw new Error(parsed.error);
      return { feed: parsed.feed, skipped: parsed.skipped };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("it did not answer in time");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let store: AnnouncementStore | undefined;

export function announcementStore(): AnnouncementStore {
  return store ??= new AnnouncementStore({ dataDir: DATA_DIR });
}
