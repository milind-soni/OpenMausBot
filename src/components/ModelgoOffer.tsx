import { useEffect, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { reportModelgoOffer } from "@/lib/modelgo-offer";
import { MODELGO_URL } from "../../shared/modelgo";
import { LinkButton, NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";
import { ModelgoMark } from "./ProviderIcons";

export type ModelgoCardAction = "get_key" | "not_now" | "close";

export function ModelgoOfferCard({ onDone }: { onDone: (action: ModelgoCardAction) => void }) {
  return <NoticeCard titleId="modelgo-offer-title" notice="modelgo-offer" icon={ModelgoMark} title={t("modelgoOffer.title")} onDismiss={() => onDone("close")}>
    <p className="mt-1 text-[13px] leading-[18px] text-ink-secondary">{t("modelgoOffer.line")}</p>
    <p data-modelgo-sponsor className="mt-1 text-[11px] leading-4 text-ink-tertiary">{t("modelgoOffer.sponsor")}</p>
    <div className="mt-3 flex flex-col gap-2">
      <LinkButton url={MODELGO_URL} label={t("modelgoOffer.getKey")} className={cn(PRIMARY_BUTTON, "w-full")} onOpened={() => onDone("get_key")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

const GET_KEY_LINK = "inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-accent-text hover:underline";

/** The first run's row for ModelGo, among the other ways to connect an AI; `children` is its key field, when the server has the provider. */
export function ModelgoOption({ open, onToggle, children }: { open: boolean; onToggle: () => void; children?: ReactNode }) {
  useEffect(() => { reportModelgoOffer("shown", "onboarding"); }, []);
  const name = <>
    <span className="flex size-[18px] shrink-0 items-center justify-center"><ModelgoMark size={18} /></span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="truncate text-[14px] text-ink">{t("modelgoOffer.name")}</span>
        <span data-modelgo-sponsor className="shrink-0 text-[11px] leading-4 text-ink-tertiary">{t("modelgoOffer.sponsor")}</span>
      </span>
      <span className="block truncate text-[12px] leading-4 text-ink-secondary">{t("modelgoOffer.line")}</span>
    </span>
  </>;
  return <div data-modelgo-option="">
    <div className="flex items-center gap-2 pr-4 transition-colors hover:bg-ink/[0.04]">
      {children ? <button type="button" aria-expanded={open} onClick={() => { if (!open) reportModelgoOffer("add_key", "onboarding"); onToggle(); }}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left focus-visible:outline-offset-[-2px]">
        {name}
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform duration-200", open && "rotate-180")} />
      </button> : <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4">{name}</div>}
      <LinkButton url={MODELGO_URL} label={t("modelgoOffer.link")} className={GET_KEY_LINK} onOpened={() => reportModelgoOffer("get_key", "onboarding")} />
    </div>
    {open && children}
  </div>;
}
