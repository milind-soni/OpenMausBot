import { PAGE_ID, type PublishedPageCard } from "../../shared/published-page.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { PageBundleError, pageSignature, pageSource, readPageBundle, skippedNote, stillReadable, type PageBundle } from "./bundle.ts";
import { liveFiles } from "./live.ts";
import type { PagesCall, PagesClient, PagesFailure, PageUsage } from "./client.ts";
import type { PublishedPagesStore } from "./store.ts";

/** What a publish or unpublish comes to: the sentence for the bot (or the person's card), and whether it failed. */
export interface PageOutcome { status: number; text: string; card?: PublishedPageCard }

export interface PublishInput {
  botId: string;
  threadId: string;
  path: string;
  title: string;
  /** An existing page to update; without it, a page this bot already published from the same file or folder is updated. */
  pageId?: string;
  /** The bot's own folders: nothing outside them is read. */
  roots: readonly string[];
  /** Puts a card in the conversation the tool was called from; its message id, or null when the turn has ended. A live
   * card comes with the files published, so it can show the page itself. */
  post: (text: string, card: PublishedPageCard, bundle?: PageBundle) => string | null;
  /** The bot's tool call: nothing is sent to the pages service once its turn has ended or its request is gone. */
  call?: PagesCall;
  /** Publish it again by itself whenever its folder changes; kept as it was for a page published before when omitted. */
  live?: boolean;
}

const TITLE_MAX = 200;
const TITLE_REQUIRED: PageOutcome = { status: 400, text: "title is required: a short name for the page." };
const pageTitle = (raw: string) => redactSecretsInText(raw.trim()).slice(0, TITLE_MAX);
const usageWords = (usage: PageUsage) => `${usage.pages} of ${usage.limit} pages`;

/** The message text every client shows, the card's own words for one that doesn't draw it. */
export function cardText(card: PublishedPageCard): string {
  if (card.state === "limit") return card.message ?? "This account's pages are used up.";
  if (card.state === "unpublished") return `Unpublished “${card.title}”. Its link no longer opens.`;
  return `Published “${card.title}”: ${card.url}${card.usage ? ` (${usageWords(card.usage)})` : ""}`;
}

/** A publish, with the folder's fingerprint when a live republish took it before reading the files. */
type LivePublish = Pick<PublishInput, "botId" | "threadId" | "title" | "pageId" | "post" | "call" | "live"> & { signature?: string | null; refresh?: true };

/** A live page is published again at most this often, however often its folder changes. */
const LIVE_MIN_MS = 60_000;
/** A live page whose folder can't be published as it is (no index.html, over a limit) waits this long before another try. */
const LIVE_BROKEN_MS = 10 * 60_000;

const failureStatus: Record<PagesFailure["reason"], number> = { sign_in: 403, limit: 402, rate_limited: 429, gone: 410, refused: 400, unavailable: 503 };

export function createPagePublisher(deps: {
  client: PagesClient;
  store: PublishedPagesStore;
  /** Re-draws a card already in a conversation (an unpublished page's). */
  patch: (threadId: string, messageId: string, text: string, card: PublishedPageCard) => void;
  /** The folders the bot may read in the conversation of the page's latest card; null once the bot is gone. */
  liveRoots?(botId: string, threadId: string): readonly string[] | null;
  /** True while the workspace is being backed up, restored or moved: live pages wait. */
  paused?(): boolean;
}) {
  const { client, store } = deps;

  // One publish at a time per bot and source, so two at once can't both find no page and each create one.
  const queues = new Map<string, Promise<unknown>>();
  const serially = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return run;
  };

  const markUnpublished = (pageId: string, usage: PageUsage | null): PublishedPageCard | null => {
    const record = store.forget(pageId);
    if (!record) return null;
    const card: PublishedPageCard = { state: "unpublished", title: record.title, pageId, url: record.url, ...(usage ? { usage } : {}) };
    for (const shown of record.cards) {
      try { deps.patch(shown.threadId, shown.messageId, cardText(card), card); } catch { /* A conversation deleted since keeps nothing to re-draw. */ }
    }
    return card;
  };

  const pages = {
    async publish(input: PublishInput): Promise<PageOutcome> {
      if (!pageTitle(input.title)) return TITLE_REQUIRED;
      if (input.pageId !== undefined && !PAGE_ID.test(input.pageId)) return { status: 400, text: "page_id must be the id of a page you published, from its link." };
      let bundle, signature: string | null = null;
      try {
        // A live page's fingerprint is taken before its files are read, so a change made during the read is published next.
        const source = await pageSource(input.path, input.roots);
        const remembered = input.pageId ? store.get(input.pageId) : store.fromSource(input.botId, source);
        if (input.live ?? remembered?.live === true) signature = await pageSignature(source);
        bundle = await readPageBundle(input.path, input.roots);
      } catch (error) {
        if (error instanceof PageBundleError) return { status: error.status, text: error.message };
        throw error;
      }
      return publishBundle({ ...input, signature }, bundle);
    },

    /** A page built here rather than read from a folder (a chat page the person publishes from the preview); `source`
     * keeps its link across publishes. */
    async publishFiles(input: Pick<PublishInput, "botId" | "threadId" | "title" | "pageId" | "post"> & { source: string; files: PageBundle["files"] }): Promise<PageOutcome> {
      return publishBundle(input, { source: input.source, files: input.files, bytes: input.files.reduce((sum, file) => sum + file.data.byteLength, 0), skipped: [] });
    },

  };

  function publishBundle(input: LivePublish, bundle: PageBundle): Promise<PageOutcome> {
    return serially(JSON.stringify([input.botId, bundle.source]), () => publishNow(input, bundle));
  }

  async function publishNow(input: LivePublish, bundle: PageBundle): Promise<PageOutcome> {
    const title = pageTitle(input.title);
    if (!title) return TITLE_REQUIRED;
    // A republish that waited its turn behind an unpublish, or a publish that turned live off, is no longer wanted.
    if (input.refresh && !(input.pageId && store.get(input.pageId)?.live)) return { status: 409, text: "The page is no longer live." };
    const remembered = input.pageId ? store.get(input.pageId) : store.fromSource(input.botId, bundle.source);
    const target = input.pageId ?? remembered?.pageId;
    const live = input.live ?? remembered?.live === true;
    const signature = live ? input.signature ?? null : null;
    const files = live ? liveFiles(bundle.files) : bundle.files;
    let result = await client.publish({ title, files, ...(target ? { pageId: target } : {}) }, input.call);
    // The page this folder was published to before is gone (unpublished, or taken down): it gets a new link.
    if (!result.ok && result.reason === "gone" && !input.pageId && target) {
      store.forget(target);
      result = await client.publish({ title, files }, input.call);
    }
    if (!result.ok) {
      if (result.reason === "limit") {
        const card: PublishedPageCard = { state: "limit", title, message: result.message, ...(result.usage ? { usage: result.usage } : {}), ...(result.upgrade ? { upgrade: true } : {}),
          ...(result.plan ? { plan: result.plan } : {}) };
        input.post(cardText(card), card);
        return { status: 402, text: `${result.message} Tell the person this in your reply.`, card };
      }
      return { status: failureStatus[result.reason], text: result.message };
    }
    const card: PublishedPageCard = { state: "live", title, pageId: result.pageId, url: result.url, usage: result.usage };
    const messageId = input.post(cardText(card), card, bundle);
    store.published({ pageId: result.pageId, url: result.url, title, botId: remembered?.botId ?? input.botId, source: bundle.source,
      card: messageId ? { threadId: input.threadId, messageId } : null, live, signature });
    const updated = Boolean(target) && result.pageId === target;
    const lines = [
      updated ? `Updated “${title}” at the same link: ${result.url}` : `Published “${title}” at ${result.url}`,
      `Page id ${result.pageId}. This account now has ${usageWords(result.usage)}.`,
      "A card with the link, Copy link and Unpublish is in the chat. Publishing the same file or folder again updates this same link.",
      ...(live ? ["It is live: when a file in its folder changes, it is published again by itself (at most once a minute) and open copies reload."] : []),
      ...(result.badge ? ["Free pages carry a small “Made with MausBot” badge."] : []),
      skippedNote(bundle.skipped),
    ];
    return { status: 200, text: lines.filter(Boolean).join("\n"), card };
  }

  // When each live page may next be tried: one that fails to publish waits as long as one that changed, and one whose
  // folder can't be published as it is waits longer.
  const nextTry = new Map<string, number>();
  let refreshing = false;

  return {
    ...pages,

    /** Publishes each live page whose folder changed again, to the same link; how many were published. */
    async refreshLive(now = Date.now()): Promise<number> {
      if (refreshing || deps.paused?.()) return 0;
      refreshing = true;
      let changed = 0;
      try {
        for (const record of store.list().filter((each) => each.live)) {
          if (now < Math.max(record.updatedAt + LIVE_MIN_MS, nextTry.get(record.pageId) ?? 0)) continue;
          // The bot is gone or no longer has the folder: the page stays at its link as it is, and stops being republished.
          const threadId = record.cards.at(-1)?.threadId;
          if (deps.liveRoots && !(await stillReadable(record.source, threadId ? deps.liveRoots(record.botId, threadId) : null))) {
            store.published({ ...record, card: null, live: false }, record.updatedAt);
            continue;
          }
          const signature = await pageSignature(record.source);
          if (signature === null || signature === record.signature) continue;
          nextTry.set(record.pageId, now + LIVE_MIN_MS);
          let bundle;
          try {
            bundle = await readPageBundle(record.source, [record.source], undefined, { exactRoots: true });
          } catch (error) {
            if (!(error instanceof PageBundleError)) throw error;
            nextTry.set(record.pageId, now + LIVE_BROKEN_MS);
            continue;
          }
          if (bundle.source !== record.source) continue;
          // A backup or move began while the folder was read: nothing is sent; the folder is read again after it.
          if (deps.paused?.()) { nextTry.delete(record.pageId); break; }
          const outcome = await publishBundle({ botId: record.botId, threadId: "", title: record.title, pageId: record.pageId, post: () => null, live: true, signature, refresh: true }, bundle);
          if (outcome.status === 200) changed++;
          // Taken down elsewhere: its cards say so, and it stops being published.
          else if (outcome.status === 410) markUnpublished(record.pageId, null);
        }
      } catch (error) {
        console.error("pages: live page refresh failed", error);
      } finally {
        refreshing = false;
      }
      return changed;
    },

    /** Takes a page down, by its id or the file or folder it came from (with the bot's folders). */
    async unpublish(input: { pageId?: string; path?: string; botId?: string; roots?: readonly string[]; call?: PagesCall }): Promise<PageOutcome> {
      let pageId = input.pageId;
      if (pageId !== undefined && !PAGE_ID.test(pageId)) return { status: 400, text: "page_id must be the id of a page you published, from its link." };
      if (!pageId && input.path && input.botId && input.roots) {
        try {
          pageId = store.fromSource(input.botId, await pageSource(input.path, input.roots))?.pageId;
        } catch (error) {
          if (!(error instanceof PageBundleError)) throw error;
        }
        if (!pageId) return { status: 404, text: `No page was published from ${input.path}. Pass the page_id from its link instead.` };
      }
      if (!pageId) return { status: 400, text: "Pass the page_id of the page to unpublish, or the path it was published from." };
      const title = store.get(pageId)?.title;
      const result = await client.unpublish(pageId, input.call);
      if (!result.ok && result.reason !== "gone") return { status: failureStatus[result.reason], text: result.message };
      const card = markUnpublished(pageId, result.ok ? result.usage : null)
        ?? { state: "unpublished" as const, title: title ?? pageId, pageId, ...(result.ok && result.usage ? { usage: result.usage } : {}) };
      return { status: 200, text: result.ok ? `Unpublished${title ? ` “${title}”` : ""}. Its link no longer opens.` : "That page was already taken down.", card };
    },
  };
}
export type PagePublisher = ReturnType<typeof createPagePublisher>;
