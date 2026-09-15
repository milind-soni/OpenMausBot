// SupaMaus captures as a recall source (Phase 1 part 2, gap analysis §11c).
//
// SupaMaus keeps its own store and its own search; the harness copies
// nothing and builds no second index. It reads the local REST history
// (loopback, bearer token the app writes to disk) and matches the query's
// terms in-process over what a capture says about itself: app, window,
// the spoken transcript, dropped text, the URL. A hit is an id plus one
// line of text; the capture itself stays where it is. Where SupaMaus is
// not on this machine the source is silently empty, on every engine alike.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CaptureHit {
  id: string;
  at: number;
  app: string;
  title: string;
  text: string;
}

export interface SupamausClient {
  enabled(): boolean;
  /** Captures matching any term of the query, richer matches first. */
  search(query: string, limit?: number): Promise<CaptureHit[]>;
  /** Captures newer than `withinMs`, newest first. */
  recent(withinMs: number, limit?: number): Promise<CaptureHit[]>;
  /** Start a background refresh when the cache is stale; never waits. The
   * turn path must not yield before dispatch (thread capacity and queued
   * threads rely on its ordering), so it reads the cache and primes it. */
  prime(): void;
  searchNow(query: string, limit?: number): CaptureHit[];
  recentNow(withinMs: number, limit?: number): CaptureHit[];
}

export const SUPAMAUS_URL = "http://127.0.0.1:19741";
export const SUPAMAUS_TOKEN_PATH = join(homedir(), "Library", "Application Support", "SupaMaus", "server-token");
const HISTORY_LIMIT = 200;
/** From this many query terms on, a hit must share two of them. */
export const MIN_TERMS_QUERY = 3;
const TEXT_CHARS = 300;

interface HistoryItem {
  id?: unknown;
  createdAt?: unknown;
  appName?: unknown;
  windowTitle?: unknown;
  spokenTranscript?: unknown;
  droppedItemText?: unknown;
  droppedItemTitle?: unknown;
  browserURL?: unknown;
  summary?: unknown;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function toHit(item: HistoryItem): CaptureHit | null {
  const id = str(item.id);
  const at = Date.parse(str(item.createdAt));
  if (!id || !Number.isFinite(at)) return null;
  const text = (str(item.spokenTranscript) || str(item.droppedItemText) || str(item.summary) || str(item.droppedItemTitle) || str(item.browserURL))
    .replace(/\s+/g, " ").trim().slice(0, TEXT_CHARS);
  return { id, at, app: str(item.appName), title: str(item.windowTitle), text };
}

/** Words that say nothing about which capture is meant. */
const STOP = new Set(("the and for are was were what when where which who why how this that these those with from " +
  "into about have has had not but you your our its they them their there here will would could should can did does " +
  "all any some then than just also one two get got let make please know tell say said want need use using before after " +
  "again only very more most such each other off per via out over did done doing been being had has yes okay").split(" "));

/** Content words of three letters or more, lowercased, distinct, no filler. */
export function captureTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const term = raw.replace(/^-+|-+$/g, "");
    if (term.length >= 3 && !STOP.has(term)) seen.add(term);
  }
  return [...seen];
}

export function supamausClient(opts: {
  url?: string;
  tokenPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
} = {}): SupamausClient {
  const url = (opts.url ?? SUPAMAUS_URL).replace(/\/+$/, "");
  const tokenPath = opts.tokenPath ?? SUPAMAUS_TOKEN_PATH;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const cacheMs = opts.cacheMs ?? 30_000;
  let cache: { at: number; hits: CaptureHit[] } | null = null;

  const token = (): string | null => {
    try {
      const value = readFileSync(tokenPath, "utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  };

  const history = async (): Promise<CaptureHit[]> => {
    if (cache && now() - cache.at < cacheMs) return cache.hits;
    const bearer = token();
    if (!bearer) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      // raced as well as signalled: a fetch that ignores the signal must
      // still not hold a turn past the timeout
      const res = await Promise.race([
        fetchImpl(`${url}/v1/history?limit=${HISTORY_LIMIT}`, { headers: { authorization: `Bearer ${bearer}` }, signal: controller.signal }),
        new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), timeoutMs); t.unref?.(); }),
      ]);
      if (!res || !res.ok) return [];
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return [];
      const hits = body.map((item) => toHit(item as HistoryItem)).filter((hit): hit is CaptureHit => hit !== null);
      cache = { at: now(), hits };
      return hits;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };

  const rank = (hits: readonly CaptureHit[], query: string, limit: number): CaptureHit[] => {
    const terms = captureTerms(query);
    if (!terms.length) return [];
    // one shared word out of many is a coincidence, not a match: a question
    // of several terms must share at least two with a capture
    const minimum = terms.length >= MIN_TERMS_QUERY ? 2 : 1;
    return hits
      .map((hit) => {
        const haystack = `${hit.app} ${hit.title} ${hit.text}`.toLowerCase();
        return { hit, score: terms.filter((term) => haystack.includes(term)).length };
      })
      .filter((entry) => entry.score >= minimum)
      .sort((a, b) => b.score - a.score || b.hit.at - a.hit.at)
      .slice(0, limit)
      .map((entry) => entry.hit);
  };
  const newest = (hits: readonly CaptureHit[], withinMs: number, limit: number): CaptureHit[] => {
    const since = now() - withinMs;
    return hits.filter((hit) => hit.at >= since).sort((a, b) => b.at - a.at).slice(0, limit);
  };
  let refreshing: Promise<CaptureHit[]> | null = null;
  const cached = (): CaptureHit[] => (cache && now() - cache.at < cacheMs ? cache.hits : cache?.hits ?? []);

  return {
    enabled: () => token() !== null,
    async search(query, limit = 4) {
      return rank(await history(), query, limit);
    },
    async recent(withinMs, limit = 3) {
      return newest(await history(), withinMs, limit);
    },
    prime() {
      if (refreshing || (cache && now() - cache.at < cacheMs) || token() === null) return;
      refreshing = history().finally(() => { refreshing = null; });
    },
    searchNow(query, limit = 4) {
      return rank(cached(), query, limit);
    },
    recentNow(withinMs, limit = 3) {
      return newest(cached(), withinMs, limit);
    },
  };
}
