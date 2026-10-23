import { join } from "node:path";
import type { PublishedPageCard } from "../../shared/published-page.ts";
import type { ChatApps } from "../chat-apps.ts";
import { createPagesInternalRoutes, createPublishedPageRoutes } from "../routes/published-pages.ts";
import type { Store } from "../store.ts";
import { applyIncludedPagesMessage, pagesAccess, pagesNotOffered } from "./access.ts";
import { createPagesClient } from "./client.ts";
import { createPagePublisher } from "./publisher.ts";
import { PublishedPagesStore } from "./store.ts";

/** Pages bots publish to a link: the bot tools' internal routes, the card's Unpublish, the desktop's sign-in message, and
 * the chat's page cards, which show a published page and its link. */
export function createPublishedPages(options: {
  dataDir: string;
  /** This server's Cloud home configuration, or null on a desktop or any other server. */
  cloudHome: { adminOrigin: string; machineId: string; bootstrapSecret: string } | null;
  patch: (threadId: string, messageId: string, text: string, card: PublishedPageCard) => void;
  fetch?: typeof fetch;
  apps?: {
    chat: Pick<ChatApps, "publishablePage" | "showPublishedPage">;
    store: Pick<Store, "botByThread" | "groupByThread" | "messagesFor" | "patchMessage">;
  };
}) {
  const store = new PublishedPagesStore(join(options.dataDir, "published-pages.json"));
  const client = createPagesClient({ access: () => pagesAccess(options.cloudHome), notOffered: () => pagesNotOffered(options.cloudHome),
    ...(options.fetch ? { fetch: options.fetch } : {}) });
  const apps = options.apps;
  const pageRow = (threadId: string, messageId: string) => apps?.store.messagesFor(threadId).find((message) => message.id === messageId && message.kind === "app");
  // A page card keeps its own text, the page's: only the card's link changes.
  const patch = (threadId: string, messageId: string, text: string, card: PublishedPageCard) => {
    if (pageRow(threadId, messageId)) apps!.store.patchMessage(threadId, messageId, { publishedPage: card });
    else options.patch(threadId, messageId, text, card);
  };
  const publisher = createPagePublisher({ client, store, patch });
  const appPages = apps ? {
    botOf: (threadId: string) => (apps.store.groupByThread(threadId) ? null : apps.store.botByThread(threadId) ?? null),
    page: (threadId: string, messageId: string, rev?: number) => apps.chat.publishablePage(threadId, messageId, rev),
    published: (threadId: string, messageId: string) => {
      const card = pageRow(threadId, messageId)?.publishedPage;
      return card?.state === "live" && card.pageId ? card.pageId : null;
    },
    show: (threadId: string, messageId: string, publishedPage: PublishedPageCard) =>
      (pageRow(threadId, messageId) && apps.store.patchMessage(threadId, messageId, { publishedPage }) ? messageId : null),
  } : undefined;
  return {
    store, publisher, internal: createPagesInternalRoutes(publisher), routes: createPublishedPageRoutes(publisher, appPages), receive: applyIncludedPagesMessage,
    /** publish_page's card as the page itself, inline; null when it can't be shown so (the caller posts the link). */
    show: (args: Parameters<ChatApps["showPublishedPage"]>[0]) => apps?.chat.showPublishedPage(args) ?? null,
  };
}
