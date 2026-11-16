import { useMemo } from "react";
import { ArrowUpRight, Eye } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import type { AppPreview } from "@/lib/app-preview";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { showAppBesideChat } from "@/lib/page-open";
import { publishedSiteLinks } from "@/lib/published-site-links";
import { isLiveReply } from "@/state/live-reply";
import type { Message } from "@/state/store";
import { useOptionalStoreRef } from "@/state/store-ref";
import { ASK_CHIP, ASK_CHIP_IDLE } from "../AskCard";
import { SiteThumb } from "./SiteThumb";

/** One card under a bot's reply for each site it links to that a bot put online: the site drawn small, its name and
 * address, Open (the preview beside the chat, full screen on a phone) and Open in browser. Nothing while the reply is
 * still streaming. */
export function PublishedSiteCards({ message }: { message: Message }) {
  const done = message.role === "bot" && message.kind === "text" && !isLiveReply(message);
  const text = done ? message.text ?? "" : "";
  const origin = typeof window === "undefined" ? undefined : window.location?.origin;
  const links = useMemo(() => (text && origin ? publishedSiteLinks(text, origin) : []), [text, origin]);
  if (links.length === 0) return null;
  return (
    <div data-published-sites="" className="flex w-full flex-col items-start gap-2">
      {links.map((link) => <PublishedSiteCard key={link.url} link={link} />)}
    </div>
  );
}

function PublishedSiteCard({ link }: { link: AppPreview }) {
  const store = useOptionalStoreRef();
  const host = new URL(link.url).host;
  const preview = () => {
    if (store) showAppBesideChat(store.dispatch, link);
    else void openExternalLink(link.url).catch(() => undefined);
  };
  const browser = () => void openExternalLink(link.url).catch(() => undefined);
  return (
    <div role="group" aria-label={link.title} data-published-site={link.url} className="w-full max-w-md overflow-hidden rounded-xl border border-hairline/40 bg-panel text-sm max-md:max-w-none">
      <button type="button" onClick={preview} aria-label={t("publishedApps.card.previewOf", { name: link.title })}
        className="block w-full border-b border-hairline/30 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        <SiteThumb url={link.url} title={link.title} loginOnly={link.loginOnly === true} sayLogin />
      </button>
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
