import { useId, useState } from "react";
import { Gift, Mail } from "lucide-react";
import { track } from "@/lib/analytics";
import { openEmailDraft } from "@/lib/app-links";
import { BOAT_OFFER, boatClaimMailto, boatOfferRuns } from "@/lib/boat-offer";
import { brandStatus } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { LinkButton, NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

export type BoatOfferAction = "get_boat" | "claim" | "not_now" | "close";
type BoatOfferPlace = "card" | "settings";

export function reportBoatOffer(action: BoatOfferAction | "shown", place: BoatOfferPlace) {
  track("boat_offer", { action, place });
}

function BoatOfferWords() {
  return <>
    <p className="mt-1 text-[13px] leading-[18px] text-ink-secondary">{t("boatOffer.body")}</p>
    <p data-boat-offer-yourself className="mt-2 text-[13px] font-semibold leading-[18px] text-ink">{t("boatOffer.yourself")}</p>
  </>;
}

const CLAIM_BUTTON = "ui-button min-h-9 gap-1.5 px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function ClaimButton({ onOpened, className }: { onOpened?: () => void; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <div>
    <button type="button" data-boat-claim className={cn(CLAIM_BUTTON, className)} onClick={() => {
      setFailed(false);
      void openEmailDraft(boatClaimMailto()).then(onOpened, () => setFailed(true));
    }}>
      <Mail size={14} aria-hidden="true" className="shrink-0" />{t("boatOffer.claim")}
    </button>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("boatOffer.mailFailed", { address: BOAT_OFFER.claimTo })}</p>}
  </div>;
}

export function BoatOfferCard({ onDone }: { onDone: (action: BoatOfferAction) => void }) {
  return <NoticeCard titleId="boat-offer-title" notice="boat-offer" icon={Gift} title={t("boatOffer.title")} onDismiss={() => onDone("close")}>
    <BoatOfferWords />
    <div className="mt-3 flex flex-col gap-2">
      <LinkButton url={BOAT_OFFER.url} label={t("boatOffer.get")} className={cn(PRIMARY_BUTTON, "w-full")} onOpened={() => onDone("get_boat")} />
      <ClaimButton className="w-full" onOpened={() => onDone("claim")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

export function BoatOfferPanel() {
  const titleId = useId();
  if (!boatOfferRuns(Date.now()) || brandStatus().source === "file") return null;
  return <section data-boat-offer aria-labelledby={titleId} className="rounded-lg bg-ink/[0.04] p-3">
    <h3 id={titleId} className="flex items-center gap-1.5 text-[13px] font-semibold leading-[18px] text-ink">
      <Gift size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />{t("boatOffer.title")}
    </h3>
    <BoatOfferWords />
    <div className="mt-3 flex flex-wrap items-start gap-2">
      <LinkButton url={BOAT_OFFER.url} label={t("boatOffer.get")} onOpened={() => reportBoatOffer("get_boat", "settings")} />
      <ClaimButton onOpened={() => reportBoatOffer("claim", "settings")} />
    </div>
  </section>;
}
