// What the Published apps page lists and deletes: the pages this server published to a MausBot link, the sites bots
// published to the person's own Netlify account, and the apps on the hosting the Cloud plan includes.
//
// Security: everything here answers for one viewer. An app is theirs to see only through a bot they can see and, where
// conversations have audiences of their own (a Team Cloud), a conversation they can read in which that bot published
// it: a page's own cards; for a Netlify site or an included app the conversation whose own folder holds its record, or,
// for a record in a folder the bot's conversations share, the bot's message carrying its link. So the list never names
// an app, or its address, from a conversation the viewer cannot read. An included app whose record is gone belongs to no
// conversation: only a viewer who sees everything here is shown it.
import type { PublishedApp, PublishedAppDeleteFailure, PublishedAppDeleteRefusal } from "../../shared/published-apps.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dirname, resolve } from "node:path";
import type { AppPublisher } from "./app-publisher.ts";
import type { HostedApp, IncludedHosting } from "./included-hosting.ts";
import { deleteNetlifySite, findNetlifySites, forgetSiteRecord, within, type NetlifySite } from "./netlify-sites.ts";

interface AppBot { id: string; name: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> }
interface AppRoom { threadId: string; memberIds: readonly string[]; tasks?: ReadonlyArray<{ threadId: string }> }
interface AppMessage { role: string; text?: string; from?: { botId?: string } }

export interface PublishedAppsDeps {
  bots(): readonly AppBot[];
  rooms(): readonly AppRoom[];
  messages(threadId: string): readonly AppMessage[];
  /** The bot's own folders, the ones its turns work in. */
  folders(bot: AppBot): readonly string[];
  /** The folder that is one conversation's alone: only its own turns work there. */
  ownFolder(botId: string, threadId: string): string;
  pages(): readonly PublishedPageRecord[];
  unpublishPage(pageId: string): Promise<{ status: number; text: string }>;
  /** Security: the Netlify token this person's own action may use for this bot's app from this conversation, or null.
   * Never another person's. */
  netlifyToken(botId: string, auth: RequestAuth, threadId: string | undefined): string | null;
  /** True when the conversation is this person's own private one (a Team Cloud). */
  ownChat(auth: RequestAuth, threadId: string): boolean;
  /** The plan's included app hosting; absent where this server has none. */
  included?: { hosting: IncludedHosting; publisher: AppPublisher };
  home: string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export const MAX_LISTED = 500;
const MAX_THREADS_SEARCHED = 300;
/** Long enough for the list and the framing checks a page sends together to share one read of the folders. */
const SCAN_FRESH_MS = 2_000;
const INCLUDED_LIST_TIMEOUT_MS = 8_000;

/** One source of published apps. A second kind of hosting adds an entry here: how its apps are found, and how one is
 * deleted for the person asking. */
interface Entry {
  app: Omit<PublishedApp, "canDelete" | "threadId">;
  /** The conversations the bot published it in; the viewer needs one of them. */
  threads(): readonly string[];
  /** The one conversation it certainly came from, when where it is kept says so. */
  home?: string;
  /** A page has only its conversations; a site in a bot's folder is the bot's where conversations share one audience. */
  needsThread: boolean;
  remove(auth: RequestAuth, threadId: string | undefined): Promise<PublishedAppDeleteRefusal | null>;
}

type Shown = { app: PublishedApp; entry: Entry };
export type DeleteAnswer = { status: 200; body: { ok: true } } | { status: 403 | 404 | 409 | 502; body: PublishedAppDeleteFailure };

const REFUSALS: Record<PublishedAppDeleteRefusal, { status: 403 | 404 | 409 | 502; error: string }> = {
  gone: { status: 404, error: "No such published app." },
  forbidden: { status: 403, error: "This app isn't yours to delete." },
  no_token: { status: 409, error: "No saved Netlify token can be used for this, so the app can't be deleted from here. Delete it on Netlify." },
  token_refused: { status: 409, error: "Netlify refused the saved token, so the app can't be deleted from here. Delete it on Netlify." },
  failed: { status: 502, error: "The app could not be deleted. Try again." },
};

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the site's address in a message, and not a longer host or path that only starts with it. */
export function linkPattern(url: string): RegExp {
  const { origin, pathname } = new URL(url);
  return new RegExp(`${escaped(origin + pathname.replace(/\/+$/, ""))}(?![\\w-]|\\.[\\w-])`, "i");
}

export function createPublishedApps(deps: PublishedAppsDeps) {
  const now = deps.now ?? Date.now;
  const scans = new Map<string, { at: number; sites: Promise<NetlifySite[]> }>();

  function sitesOf(bot: AppBot): Promise<NetlifySite[]> {
    const fresh = scans.get(bot.id);
    if (fresh && now() - fresh.at < SCAN_FRESH_MS) return fresh.sites;
    const sites = findNetlifySites(deps.folders(bot), { home: deps.home, env: deps.env }).catch(() => []);
    scans.set(bot.id, { at: now(), sites });
    return sites;
  }

  type IncludedListing = Awaited<ReturnType<IncludedHosting["list"]>> | null;
  let includedListing: { at: number; listing: Promise<IncludedListing> } | null = null;
  /** What the relay holds for this Cloud; null where there is no included hosting or it can't be reached right now. */
  function includedApps(): Promise<IncludedListing> {
    const hosting = deps.included?.hosting;
    if (!hosting?.available()) return Promise.resolve(null);
    if (includedListing && now() - includedListing.at < SCAN_FRESH_MS) return includedListing.listing;
    const listing = hosting.list(AbortSignal.timeout(INCLUDED_LIST_TIMEOUT_MS)).catch(() => null);
    includedListing = { at: now(), listing };
    return listing;
  }

  function botThreads(bot: AppBot): string[] {
    const own = [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)];
    const shared = deps.rooms().filter((room) => room.memberIds.includes(bot.id)).flatMap((room) => [room.threadId, ...(room.tasks ?? []).map((task) => task.threadId)]);
    return [...new Set([...own, ...shared])].slice(-MAX_THREADS_SEARCHED);
  }

  /** The conversations in which this bot itself wrote the site's link. */
  function postedIn(bot: AppBot, site: NetlifySite): string[] {
    const link = linkPattern(site.url), own = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    return botThreads(bot).filter((threadId) => deps.messages(threadId).some((message) =>
      message.role === "bot" && typeof message.text === "string" && (own.has(threadId) ? !message.from?.botId || message.from.botId === bot.id : message.from?.botId === bot.id) && link.test(message.text)));
  }

  async function removeSite(bot: AppBot, site: NetlifySite, auth: RequestAuth, threadId: string | undefined): Promise<PublishedAppDeleteRefusal | null> {
    const token = deps.netlifyToken(bot.id, auth, threadId);
    if (!token) return "no_token";
    const deleted = await deleteNetlifySite(site.siteId, token, { env: deps.env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    if (!deleted.ok) return deleted.reason;
    await forgetSiteRecord(site, deps.folders(bot), deps.env);
    scans.delete(bot.id);
    return null;
  }

  function pageEntries(): Entry[] {
    const names = new Map(deps.bots().map((bot) => [bot.id, bot.name]));
    return deps.pages().map((page) => ({
      app: { id: `page-${page.pageId}`, source: "page" as const, title: page.title || page.pageId, url: page.url, bot: { id: page.botId, name: names.get(page.botId) ?? "" },
        publishedAt: page.updatedAt, access: "link" as const },
      threads: () => page.cards.map((card) => card.threadId).reverse(),
      needsThread: true,
      remove: async () => ((await deps.unpublishPage(page.pageId)).status === 200 ? null : "failed"),
    }));
  }

  /** The conversations a record in a bot's folder speaks for: the one whose own folder holds it, else those where the
   * bot posted the app's link. */
  function recordThreads(bot: AppBot, site: NetlifySite, url: string): Pick<Entry, "threads" | "home" | "needsThread"> {
    let posted: string[] | undefined;
    const folder = dirname(resolve(site.file));
    const home = [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)].find((threadId) => within(folder, resolve(deps.ownFolder(bot.id, threadId))));
    return { threads: () => (home ? [home] : (posted ??= url ? postedIn(bot, { ...site, url }) : [])), ...(home ? { home } : {}), needsThread: false };
  }

  async function siteEntries(bots: readonly AppBot[]): Promise<Entry[]> {
    const found = await Promise.all(bots.map(async (bot) => ({ bot, sites: await sitesOf(bot) })));
    return found.flatMap(({ bot, sites }) => sites.filter((site) => !site.hosting).map((site) => ({
      app: { id: `netlify-${bot.id}-${site.siteId}`, source: "netlify" as const, title: site.title, url: site.url, bot: { id: bot.id, name: bot.name },
        publishedAt: site.publishedAt, access: site.access, ...(site.manageUrl ? { manageUrl: site.manageUrl } : {}) },
      ...recordThreads(bot, site, site.url),
      remove: (auth: RequestAuth, threadId: string | undefined) => removeSite(bot, site, auth, threadId),
    })));
  }

  function includedApp(hosted: HostedApp, bot: { id: string; name: string }, recorded?: NetlifySite): Entry["app"] {
    const status = hosted.state === "taken_down" ? "taken_down" as const : hosted.publishedAt === null || !hosted.url ? "not_live" as const : undefined;
    return {
      id: `included-${hosted.key}`, source: "included", title: hosted.title || recorded?.title || hosted.key, url: hosted.url ?? "", bot,
      publishedAt: hosted.publishedAt ?? hosted.createdAt ?? recorded?.publishedAt ?? 0, access: status || hosted.visibility === "private" ? "unknown" : "public",
      ...(status ? { status } : {}),
    };
  }

  /** The plan's apps under the bots whose folders hold their records. `orphans`: also the ones no bot's folder holds. */
  async function includedEntries(bots: readonly AppBot[], orphans: boolean): Promise<Entry[]> {
    const included = deps.included, listing = await includedApps();
    if (!included || !listing?.apps.length) return [];
    const byKey = new Map(listing.apps.map((app) => [app.key, app]));
    const remove = (key: string, file: string | null) => async (): Promise<PublishedAppDeleteRefusal | null> => {
      try { await included.publisher.removeByKey(key, file); } catch { return "failed"; }
      includedListing = null;
      scans.clear();
      return null;
    };
    const claimed = new Set<string>(), entries: Entry[] = [];
    for (const bot of bots) {
      for (const site of (await sitesOf(bot)).filter((one) => one.hosting === "included")) {
        // Security: the app a record stands for is decided by the folder it is in, never by what the record says.
        const key = await included.hosting.keyFor(bot.id, dirname(resolve(site.file))).catch(() => null);
        const hosted = key ? byKey.get(key) : undefined;
        if (!key || !hosted || claimed.has(key)) continue;
        claimed.add(key);
        entries.push({ app: includedApp(hosted, { id: bot.id, name: bot.name }, site), ...recordThreads(bot, site, hosted.url ?? ""), remove: remove(key, site.file) });
      }
    }
    if (orphans) {
      for (const hosted of listing.apps) {
        if (!claimed.has(hosted.key)) entries.push({ app: includedApp(hosted, { id: "", name: "" }), threads: () => [], needsThread: false, remove: remove(hosted.key, null) });
      }
    }
    return entries;
  }

  function mayDelete(visible: VisibleSet, auth: RequestAuth, botId: string, threadId: string | undefined): boolean {
    if (!visible.member) return true;
    return visible.filtersThreads && ((threadId !== undefined && deps.ownChat(auth, threadId)) || visible.level(botId) === "edit");
  }

  async function shown(visible: VisibleSet, auth: RequestAuth): Promise<Shown[]> {
    const bots = deps.bots().filter((bot) => visible.bot(bot.id));
    const entries = [...pageEntries(), ...await siteEntries(bots), ...await includedEntries(bots, visible.everything)];
    const out: Shown[] = [];
    for (const entry of entries) {
      const botId = entry.app.bot.id;
      let threadId: string | undefined;
      if (!visible.everything) {
        if (!visible.bot(botId)) continue;
        if (entry.needsThread || visible.filtersThreads) {
          threadId = entry.threads().find((candidate) => visible.thread(candidate));
          if (threadId === undefined) continue;
        }
      } else {
        threadId = entry.home ?? (entry.needsThread ? entry.threads()[0] : undefined);
      }
      out.push({ entry, app: { ...entry.app, ...(threadId ? { threadId } : {}), canDelete: mayDelete(visible, auth, botId, threadId) } });
    }
    return out.sort((a, b) => b.app.publishedAt - a.app.publishedAt).slice(0, MAX_LISTED);
  }

  return {
    async list(visible: VisibleSet, auth: RequestAuth): Promise<PublishedApp[]> {
      return (await shown(visible, auth)).map((one) => one.app);
    },
    /** True for an address inside an app this viewer is shown. */
    async lists(visible: VisibleSet, auth: RequestAuth, url: string): Promise<boolean> {
      let asked: URL;
      try { asked = new URL(url); } catch { return false; }
      return (await shown(visible, auth)).some(({ app }) => {
        if (!app.url) return false;
        const base = new URL(app.url);
        return asked.origin === base.origin && asked.pathname.startsWith(base.pathname);
      });
    },
    /** The plan's apps in use and how many it includes: the whole Cloud's, so a team's. Null where the plan includes
     * none and none is published, or the relay can't be reached. */
    async allowance(): Promise<{ used: number; max: number } | null> {
      const apps = (await includedApps())?.allowance.apps;
      return apps && (apps.max > 0 || apps.used > 0) ? apps : null;
    },
    async remove(visible: VisibleSet, auth: RequestAuth, id: string): Promise<DeleteAnswer> {
      const found = (await shown(visible, auth)).find((one) => one.app.id === id);
      const refusal = !found ? "gone" : !found.app.canDelete ? "forbidden" : await found.entry.remove(auth, found.app.threadId);
      if (!refusal) return { status: 200, body: { ok: true } };
      const { status, error } = REFUSALS[refusal];
      const manageUrl = refusal === "no_token" || refusal === "token_refused" ? found?.app.manageUrl : undefined;
      return { status, body: { error, code: refusal, ...(manageUrl ? { manageUrl } : {}) } };
    },
  };
}

export type PublishedApps = ReturnType<typeof createPublishedApps>;
