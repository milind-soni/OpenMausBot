import { useState } from "react";
import { ArrowUpRight, Check, Copy, Globe, Loader2, X } from "lucide-react";
import type { PublishedPageCard as Card } from "../../shared/published-page";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { usePageOpener } from "@/lib/page-open";
import { t } from "@/lib/i18n";
import { api, useStore, type Message } from "@/state/store";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_PRIMARY_BUTTON } from "./AskCard";

const usageLine = (card: Card) => card.usage ? t("chat.page.usage", { pages: card.usage.pages, limit: card.usage.limit }) : null;

function limitLine(card: Card): string {
  const limit = card.usage?.limit;
  if (limit === undefined) return card.message ?? "";
  return card.plan === "free" ? t("chat.page.freeLimit", { limit }) : t("chat.page.planLimit", { limit, plan: cloudPlanLabel(card.plan) });
}

/** A page a bot published: its link, Copy link, Open and Unpublish; or, at the plan's limit, why not and where to get more.
 * The link and Open both open the page (usePageOpener): never a message, a turn or a chat. */
export function PublishedPageCard({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const card = message.publishedPage;
  const { state: copied, copy } = useCopyFeedback(card?.url ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const openPage = usePageOpener();
  if (!card) return null;
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const unpublish = async () => {
    if (!card.pageId) return;
    setBusy(true);
    setFailed(false);
    try { await api(`/api/published-pages/${card.pageId}/unpublish`, { method: "POST", body: "{}" }); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const usage = usageLine(card);
  return (
    <div data-published-page={card.pageId ?? "limit"} className="w-full max-w-md overflow-hidden rounded-xl border border-hairline/40 bg-panel px-3 py-2.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Globe size={16} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
        <span dir="auto" className="min-w-0 truncate font-medium text-ink" title={card.title}>{card.title}</span>
        {usage && <span className="ms-auto shrink-0 text-xs text-ink-tertiary">{usage}</span>}
      </div>
      {card.state === "live" && card.url && <>
        <a href={card.url} dir="ltr" onClick={(event) => { event.preventDefault(); openPage(card.url!); }}
          className="mt-1 block truncate text-[13px] text-accent-text hover:underline">{card.url}</a>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" onClick={copy} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            {copied === "copied" ? <Check size={14} /> : <Copy size={14} />}
            {t(copied === "copied" ? "chat.page.copied" : "chat.page.copyLink")}
          </button>
          <button type="button" onClick={() => openPage(card.url!)} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            <ArrowUpRight size={14} />{t("chat.page.open")}
          </button>
          <button type="button" onClick={() => void unpublish()} disabled={busy} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}{t("chat.page.unpublish")}
          </button>
        </div>
        {failed && <p role="alert" className="mt-1.5 text-[12px] text-danger">{t("chat.page.unpublishFailed")}</p>}
      </>}
      {card.state === "unpublished" && <p className="mt-1 text-[13px] text-ink-secondary">{t("chat.page.unpublished")}</p>}
      {card.state === "limit" && <>
        <p dir="auto" className="mt-1 text-[13px] leading-snug text-ink-secondary">{limitLine(card)}</p>
        {card.upgrade && bridge && <button type="button" className={cn(ASK_PRIMARY_BUTTON, "mt-2")}
          onClick={() => dispatch({ type: "openCloudAdd", source: "app_pages" })}>{t("chat.page.morePages")}</button>}
      </>}
    </div>
  );
}
