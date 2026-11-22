import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ArrowUpRight, Eye } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { memoInLocale } from "@/lib/locale-memo";
import { askAboutSite, useKnownPublishedApps } from "@/lib/own-published-apps";
import { showAppBesideChat } from "@/lib/page-open";
import { publishedSiteLinks, type SiteCardLink } from "@/lib/published-site-links";
import { isLiveReply } from "@/state/live-reply";
import type { Message } from "@/state/store";
import { useOptionalStoreRef } from "@/state/store-ref";
import { ASK_CHIP, ASK_CHIP_IDLE } from "../AskCard";
import { SiteThumb } from "./SiteThumb";

/** Which shown message links each site, so only the newest of them draws it. */
const claims = new Map<string, Map<string, number>>();
const claimListeners = new Set<() => void>();

function changeClaims(change: () => void): void {
  change();
  for (const listener of claimListeners) listener();
}

function subscribeClaims(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => { claimListeners.delete(listener); };
}

function newestClaim(appId: string): string | undefined {
  let best: [string, number] | undefined;
  for (const [messageId, at] of claims.get(appId) ?? []) {
    if (!best || at > best[1] || (at === best[1] && messageId > best[0])) best = [messageId, at];
  }
  return best?.[0];
}

function useNewestFor(links: readonly SiteCardLink[], messageId: string, at: number): SiteCardLink[] {
  const sites = links.map((link) => link.appId).join("\n");
  useEffect(() => {
    const ids = sites ? sites.split("\n") : [];
    if (!ids.length) return;
    changeClaims(() => { for (const id of ids) { if (!claims.has(id)) claims.set(id, new Map()); claims.get(id)!.set(messageId, at); } });
    return () => changeClaims(() => { for (const id of ids) { claims.get(id)?.delete(messageId); if (claims.get(id)?.size === 0) claims.delete(id); } });
  }, [sites, messageId, at]);
  const newest = () => links.filter((link) => newestClaim(link.appId) === messageId).map((link) => link.appId).join("\n");
  const shown = useSyncExternalStore(subscribeClaims, newest, newest);
  return useMemo(() => links.filter((link) => shown.split("\n").includes(link.appId)), [links, shown]);
}

/** One card under a bot's reply for each of the viewer's own published sites it links to (their Published apps list),
 * on the newest reply that links it: the site drawn small, its name and address, Open (the preview beside the chat,
 * full screen on a phone) and Open in browser. Any other site stays a plain link. Nothing while the reply streams, and
 * nothing on a published page's or a template's own card. */
export const PublishedSiteCards = memoInLocale(function PublishedSiteCards({ message }: { message: Message }) {
  const apps = useKnownPublishedApps();
  const done = message.role === "bot" && message.kind === "text" && !message.publishedPage && !message.template && !isLiveReply(message);
  const text = done ? message.text ?? "" : "";
  const origin = typeof window === "undefined" ? undefined : window.location?.origin;
  const { cards, unknown } = useMemo(() => (text && origin ? publishedSiteLinks(text, origin, apps) : { cards: [], unknown: [] }), [text, origin, apps]);
  useEffect(() => { for (const href of unknown) askAboutSite(href); }, [unknown]);
  const shown = useNewestFor(cards, message.id, message.at ?? 0);
  if (shown.length === 0) return null;
  return (
    <div data-published-sites="" className="flex w-full flex-col items-start gap-2">
      {shown.map((link) => <PublishedSiteCard key={link.appId} link={link} />)}
    </div>
  );
});

function PublishedSiteCard({ link }: { link: SiteCardLink }) {
  const store = useOptionalStoreRef();
  const host = new URL(link.url).host;
  const preview = () => {
    if (store) showAppBesideChat(store.dispatch, link);
    else void openExternalLink(link.url).catch(() => undefined);
  };
  const browser = () => void openExternalLink(link.url).catch(() => undefined);
  return (
    <div role="group" aria-label={link.title} data-published-site={link.url} className="w-full max-w-md overflow-hidden rounded-xl border border-hairline/40 bg-panel text-sm max-md:max-w-none">
      <div className="relative border-b border-hairline/30">
        <SiteThumb url={link.url} title={link.title} loginOnly={link.loginOnly === true} sayLogin unloadOffScreen />
        <button type="button" onClick={preview} aria-label={t("publishedApps.card.previewOf", { name: link.title })}
          className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5">
        <div className="min-w-0 flex-1 basis-40">
          {link.title !== host && <p dir="auto" className="truncate font-medium text-ink" title={link.title}>{link.title}</p>}
          <a href={link.url} dir="ltr" onClick={(event) => { event.preventDefault(); preview(); }}
            className={cn("block truncate text-[13px] hover:underline", link.title === host ? "font-medium text-ink" : "text-ink-secondary")}>{host}</a>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button type="button" onClick={preview} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}><Eye size={14} aria-hidden="true" />{t("chat.page.open")}</button>
          <button type="button" onClick={browser} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}><ArrowUpRight size={14} aria-hidden="true" />{t("webPanels.page.openInBrowser")}</button>
        </div>
      </div>
    </div>
  );
}
