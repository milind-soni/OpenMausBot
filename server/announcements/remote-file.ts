// A small JSON file the project publishes on main, kept the way the model manifest (server/model-manifest/manifest.ts)
// keeps its list: a copy bundled with this release, a disk cache of the last good download, and a download from main on
// raw.githubusercontent.com. The announcement cards (feed.ts) and the release notes (release-notes.ts) both use it.
// It never runs on a timer of its own: a page asks at launch and about hourly (src/lib/announcements.ts), and that ask
// refreshes the copy here when it is an hour old, so a server nobody opens never downloads it. The request is a plain
// anonymous GET: no cookie, no id, no version.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "../atomic.ts";

/** "1" stops the download and everything these files show on this server's pages, the bundled copies included. */
export const ANNOUNCEMENTS_DISABLE_ENV = "OMB_DISABLE_ANNOUNCEMENTS";
export const REMOTE_FILE_TTL_MS = 60 * 60 * 1000;
/** Back off failed fetches, so an offline computer does not try on every page load. */
export const REMOTE_FILE_RETRY_MS = 5 * 60 * 1000;
export const REMOTE_FILE_FETCH_TIMEOUT_MS = 10_000;
/** How long a page's ask waits for a first download when there is no copy on disk yet; after that it gets what is here. */
export const REMOTE_FILE_FIRST_WAIT_MS = 3_000;

export type RemoteParse<T> = (value: unknown, nowMs: number) => { ok: true; value: T; skipped: string[] } | { ok: false; error: string };

export interface RemoteFileOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  log?: (message: string) => void;
}

export interface RemoteFileSpec<T> {
  /** For the log: `[name] ...`. */
  name: string;
  url: string;
  cachePath: string;
  bundled: T;
  maxBytes: number;
  parse: RemoteParse<T>;
  /** The file's own `updatedAt`: an older copy never replaces a newer one. */
  updatedAt: (value: T) => string;
}

export class RemoteJsonFile<T> {
  private readonly options: RemoteFileOptions;
  private readonly spec: RemoteFileSpec<T>;
  private value: T;
  private fetchedAtMs: number | null = null;
  private lastAttemptMs: number | null = null;
  private diskChecked = false;
  private inflight: Promise<T> | undefined;

  constructor(options: RemoteFileOptions, spec: RemoteFileSpec<T>) {
    this.options = options;
    this.spec = spec;
    this.value = spec.bundled;
  }

  protected get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(text: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(`[${this.spec.name}] ${text}`);
  }

  get disabled(): boolean {
    return (this.options.env ?? process.env)[ANNOUNCEMENTS_DISABLE_ENV] === "1";
  }

  /** The newest usable copy. Reads the disk cache once and never waits on the network. */
  current(): T {
    if (!this.diskChecked) this.loadDiskCache();
    return this.value;
  }

  /** Skipped inside `ttlMs` of the last good fetch and for a while after a failed one, unless `force`. Concurrent calls
   * share one request. Never throws. */
  refresh(options: { force?: boolean; ttlMs?: number } = {}): Promise<T> {
    if (this.disabled) return Promise.resolve(this.current());
    this.inflight ??= this.fetchAndStore(Boolean(options.force), options.ttlMs ?? REMOTE_FILE_TTL_MS).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** A page's ask: refreshes in the background, waiting a moment for a first download only when nothing was ever fetched. */
  async ready(firstWaitMs = REMOTE_FILE_FIRST_WAIT_MS): Promise<void> {
    if (this.disabled) return;
    this.current();
    const refreshing = this.refresh().catch(() => this.value);
    if (this.fetchedAtMs !== null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refreshing, new Promise((resolve) => { timer = setTimeout(resolve, firstWaitMs); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  private get maxBytes(): number {
    return this.options.maxBytes ?? this.spec.maxBytes;
  }

  private updatedAtMs(value: T): number {
    return Date.parse(this.spec.updatedAt(value));
  }

  private loadDiskCache(): void {
    this.diskChecked = true;
    const path = this.spec.cachePath;
    try {
      if (!existsSync(path) || statSync(path).size > this.maxBytes * 2) return;
      const raw = JSON.parse(readFileSync(path, "utf8")) as { fetchedAtMs?: unknown; feed?: unknown };
      const parsed = this.spec.parse(raw.feed, this.now);
      if (!parsed.ok) {
        this.log(`ignoring the cached copy (${parsed.error})`);
        return;
      }
      if (this.updatedAtMs(this.value) > this.updatedAtMs(parsed.value)) return;
      this.value = parsed.value;
      this.fetchedAtMs = typeof raw.fetchedAtMs === "number" && Number.isFinite(raw.fetchedAtMs) ? raw.fetchedAtMs : null;
    } catch (error) {
      this.log(`could not read the cached copy (${message(error)})`);
    }
  }

  private async fetchAndStore(force: boolean, ttlMs: number): Promise<T> {
    this.current();
    const now = this.now;
    // Expire timestamps from the future after a clock rollback; the cache crosses restarts, so no monotonic clock.
    const within = (sinceMs: number | null, windowMs: number) => sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (!force && within(this.fetchedAtMs, ttlMs)) return this.value;
    if (!force && within(this.lastAttemptMs, REMOTE_FILE_RETRY_MS)) return this.value;
    this.lastAttemptMs = now;

    let fetched: T;
    try {
      const result = await this.download();
      fetched = result.value;
      for (const skipped of result.skipped) this.log(`skipping ${skipped}`);
    } catch (error) {
      this.log(`could not refresh the ${this.spec.name} (${message(error)}); keeping the current copy`);
      return this.value;
    }
    // A stale CDN copy loses to what we already have, so it cannot bring back an entry a newer copy removed.
    if (this.updatedAtMs(fetched) < this.updatedAtMs(this.value)) {
      this.log(`ignoring a downloaded copy older than the current one (${this.spec.updatedAt(fetched)})`);
      return this.value;
    }
    this.value = fetched;
    this.fetchedAtMs = now;
    this.lastAttemptMs = null;
    try {
      mkdirSync(dirname(this.spec.cachePath), { recursive: true });
      writeFileAtomic(this.spec.cachePath, JSON.stringify({ fetchedAtMs: now, feed: fetched }));
    } catch (error) {
      this.log(`could not save the downloaded ${this.spec.name} (${message(error)})`);
    }
    return this.value;
  }

  private async download(): Promise<{ value: T; skipped: string[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? REMOTE_FILE_FETCH_TIMEOUT_MS);
    try {
      const response = await (this.options.fetch ?? fetch)(this.spec.url, {
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
      const parsed = this.spec.parse(json, this.now);
      if (!parsed.ok) throw new Error(parsed.error);
      return { value: parsed.value, skipped: parsed.skipped };
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
