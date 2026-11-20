// The marketplace catalog: one walk of its pages, and the copy the Apps page is answered from. A reader gets the copy held
// for its backend at once, whatever its age; an old copy is read again behind it, by one walk however many readers ask.
// The newest copy is also kept in the data folder, so a restart starts from it. A walk that failed or came up short never
// takes the place of a whole list: the list held stays, and the walk is tried again later, less often each time.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { canonicalToolkitSlug, MAX_CONNECTED_ACCOUNT_PAGES } from "./composio-project.ts";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  domain: string | null;
  categories?: string[];
}

export type CatalogStopReason =
  | "end"
  | "total-reached"
  | "page-stuck"
  | "cursor-repeated"
  | "http-error"
  | "bad-page"
  | "limit";

export interface CatalogPagination {
  items: number;
  /** Upstream's own count of the full marketplace, when it reports one. */
  totalItems?: number;
  /** True when paging stopped before the reported total. */
  stalled: boolean;
  reason?: CatalogStopReason;
  /** True only when the walk reached its natural end without stalling. */
  complete: boolean;
}

export interface Catalog {
  cards: ToolkitCard[];
  pagination: CatalogPagination;
  /** False once the copy is older than CATALOG_FRESH_MS: still served, but no proof of what the marketplace lists now. */
  fresh: boolean;
}

/** One page of the catalog; the walk gives the cursor the page before it named. */
export type CatalogPageReader = (cursor: string | undefined) => Promise<Response>;

/** Composio lists meta.categories as `{ id, name }` objects (older payloads: plain strings). */
export function toolkitCategories(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim().slice(0, 40))
    .filter(Boolean);
  const unique = [...new Set(names)].slice(0, 4);
  return unique.length ? unique : undefined;
}

export const CATALOG_FRESH_MS = 10 * 60_000;
const MAX_HELD_CATALOGS = 4;

/** How long after each walk in a row that failed or came up short the next one waits. */
const RETRY_AFTER_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, CATALOG_FRESH_MS];
const retryAfter = (failures: number) => RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length) - 1]!;

interface HeldCatalog {
  at: number;
  cards: ToolkitCard[];
  pagination: CatalogPagination;
  digest: string;
  /** When the next reader starts a walk behind its answer. */
  walkAgainAt: number;
  failures: number;
}

export const CATALOG_FILE = "connector-catalog.json";
const savedCatalogSchema = z.object({
  version: z.literal(1),
  /** Names the backend without holding its credential. */
  key: z.string().length(64),
  at: z.number().finite().nonnegative(),
  cards: z.array(z.object({
    slug: z.string().min(1),
    label: z.string(),
    blurb: z.string(),
    logo: z.string().nullable(),
    noAuth: z.boolean().optional(),
    domain: z.string().nullable(),
    categories: z.array(z.string()).optional(),
  })).min(1),
  pagination: z.object({
    items: z.number(),
    totalItems: z.number().optional(),
    stalled: z.boolean(),
    reason: z.enum(["end", "total-reached", "page-stuck", "cursor-repeated", "http-error", "bad-page", "limit"]).optional(),
    complete: z.boolean(),
  }),
});

const held = new Map<string, HeldCatalog>();
let savedFile: string | null = null;
let savedFileRead = false;

/** Keeps the newest catalog in `dataDir` and starts from the one found there; null stops both. */
export function rememberCatalogIn(dataDir: string | null): void {
  savedFile = dataDir ? join(dataDir, CATALOG_FILE) : null;
  savedFileRead = false;
}

const savedKey = (identity: string) => createHash("sha256").update("catalog-file\0").update(identity).digest("hex");

function loadSaved(identity: string): HeldCatalog | null {
  if (!savedFile || savedFileRead) return null;
  savedFileRead = true;
  let text: string;
  try {
    text = readFileSync(savedFile, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = savedCatalogSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) {
    console.warn("[composio] the saved catalog could not be read; the catalog is read from the service instead");
    return null;
  }
  if (parsed.data.key !== savedKey(identity)) return null;
  const { cards, pagination, at } = parsed.data;
  const readAt = Math.min(at, Date.now());
  const catalog: HeldCatalog = { at: readAt, cards, pagination, digest: digestOf(cards), walkAgainAt: pagination.complete ? readAt + CATALOG_FRESH_MS : 0, failures: 0 };
  keep(identity, catalog);
  return catalog;
}

function save(identity: string, catalog: HeldCatalog): void {
  if (!savedFile) return;
  try {
    const { at, cards, pagination } = catalog;
    writeFileAtomic(savedFile, `${JSON.stringify({ version: 1, key: savedKey(identity), at, cards, pagination })}\n`, { mode: 0o600, durable: false });
  } catch (error) {
    console.warn(`[composio] could not save the catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const walks = new Map<string, Promise<HeldCatalog | null>>();
const listeners = new Set<() => void>();

/** Called when a walk behind a reader brought a list that differs from the one readers were given. */
export function onCatalogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announceChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn(`[composio] a catalog listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const digestOf = (cards: readonly ToolkitCard[]) => createHash("sha256").update(JSON.stringify(cards)).digest("hex");

async function walkCatalog(readPage: CatalogPageReader): Promise<{ cards: ToolkitCard[]; pagination: CatalogPagination } | null> {
  const items: any[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let lastReportedPage: number | undefined;
  let reportedTotalItems: number | undefined;
  let reportedTotalPages: number | undefined;
  let stop: CatalogStopReason = "limit";
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const res = await readPage(cursor).catch(() => null);
    if (!res?.ok) {
      stop = "http-error";
      break;
    }
    const json: any = await res.json().catch(() => null);
    const pageItems = json && typeof json === "object" ? json.items ?? json.data ?? [] : null;
    if (!Array.isArray(pageItems)) {
      stop = "bad-page";
      break;
    }
    items.push(...pageItems);
    const pageTotalItems = Number(json.total_items);
    if (Number.isFinite(pageTotalItems) && pageTotalItems > 0) reportedTotalItems = pageTotalItems;
    // A broker that drops the cursor can replay a page while minting fresh cursors, so trust Composio's current_page movement.
    const reportedPage = Number(json.current_page);
    if (Number.isFinite(reportedPage)) {
      if (lastReportedPage !== undefined && reportedPage <= lastReportedPage) {
        stop = "page-stuck";
        break;
      }
      lastReportedPage = reportedPage;
    }
    const pageTotalPages = Number(json.total_pages);
    if (Number.isFinite(pageTotalPages) && pageTotalPages > 0) reportedTotalPages = pageTotalPages;
    if (
      lastReportedPage !== undefined &&
      Number.isFinite(pageTotalPages) &&
      pageTotalPages > 0 &&
      lastReportedPage >= pageTotalPages
    ) {
      stop = "total-reached";
      break;
    }
    const next = typeof json.next_cursor === "string" ? json.next_cursor.trim() : "";
    if (!next) {
      stop = "end";
      break;
    }
    if (seenCursors.has(next)) {
      stop = "cursor-repeated";
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }
  if (!items.length) return null;
  const cards: ToolkitCard[] = items.map((t: any) => ({
    slug: canonicalToolkitSlug(String(t.slug ?? t.key ?? t.name ?? "")),
    label: t.name ?? t.slug ?? "",
    blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
    logo: t.meta?.logo ?? t.logo ?? null,
    noAuth: t.no_auth === true,
    domain: null,
    ...(toolkitCategories(t.meta?.categories) ? { categories: toolkitCategories(t.meta?.categories) } : {}),
  }));
  const uniqueCards = cards.filter(
    (card, index) => card.slug && cards.findIndex((candidate) => candidate.slug === card.slug) === index,
  );
  const shortOfReportedTotal = reportedTotalItems !== undefined && uniqueCards.length < reportedTotalItems;
  const pagingStoppedEarly = lastReportedPage !== undefined
    && reportedTotalPages !== undefined
    && lastReportedPage < reportedTotalPages;
  const stalled = shortOfReportedTotal || pagingStoppedEarly;
  const complete = (stop === "end" || stop === "total-reached") && !stalled;
  const pagination: CatalogPagination = { items: uniqueCards.length, stalled, complete };
  if (reportedTotalItems !== undefined) pagination.totalItems = reportedTotalItems;
  if (pagination.stalled) pagination.reason = stop;
  if (pagination.stalled) {
    console.warn(
      `[composio] marketplace catalog paging stopped early (${stop}) after ${uniqueCards.length} toolkits`
        + (reportedTotalItems !== undefined ? ` of ~${reportedTotalItems}` : "")
        + "; serving a partial marketplace",
    );
  }
  return { cards: uniqueCards, pagination };
}

function keep(identity: string, catalog: HeldCatalog): void {
  held.delete(identity);
  held.set(identity, catalog);
  while (held.size > MAX_HELD_CATALOGS) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
}

function refresh(identity: string, readPage: CatalogPageReader): Promise<HeldCatalog | null> {
  const running = walks.get(identity);
  if (running) return running;
  const walk = walkCatalog(readPage).catch(() => null).then((found) => {
    const previous = held.get(identity) ?? null;
    const now = Date.now();
    const whole = found?.pagination.complete === true;
    if (!found || (previous && !whole && (previous.pagination.complete || found.cards.length < previous.cards.length))) {
      if (previous) {
        previous.failures += 1;
        previous.walkAgainAt = now + retryAfter(previous.failures);
      }
      return previous;
    }
    const failures = whole ? 0 : (previous?.failures ?? 0) + 1;
    const next: HeldCatalog = {
      at: now, cards: found.cards, pagination: found.pagination, digest: digestOf(found.cards),
      walkAgainAt: now + (whole ? CATALOG_FRESH_MS : retryAfter(failures)), failures,
    };
    keep(identity, next);
    save(identity, next);
    if (previous && previous.digest !== next.digest) announceChange();
    return next;
  }).finally(() => {
    if (walks.get(identity) === walk) walks.delete(identity);
  });
  walks.set(identity, walk);
  return walk;
}

const answer = (catalog: HeldCatalog): Catalog => ({
  cards: catalog.cards,
  pagination: catalog.pagination,
  fresh: Date.now() - catalog.at < CATALOG_FRESH_MS,
});

/** The catalog of the backend `identity` names; null when it has never been read and can't be now. Only a backend's first
 * read waits for the walk. */
export async function catalogFor(identity: string, readPage: CatalogPageReader): Promise<Catalog | null> {
  const known = held.get(identity) ?? loadSaved(identity);
  if (known) {
    if (Date.now() >= known.walkAgainAt) void refresh(identity, readPage);
    return answer(known);
  }
  const first = await refresh(identity, readPage);
  return first ? answer(first) : null;
}

/** Resolves once no walk is running: for tests, so none outlives the stand-in it reads. */
export async function catalogWalksSettled(): Promise<void> {
  while (walks.size) await Promise.all(walks.values());
}

/** What a restart leaves: nothing in memory, the saved file still there to start from. */
export function forgetCatalogs(): void {
  held.clear();
  savedFileRead = false;
}
