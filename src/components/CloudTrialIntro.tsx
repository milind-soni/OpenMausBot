import { Check, Cloud } from "lucide-react";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { cloudIntroView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

export function CloudTrialIntroCard({ offer, onStart, onHowTo, onSignIn, onNotNow, onDismiss }: {
  offer: CloudOffer;
  onStart: () => void; onHowTo: () => void;
  onSignIn?: () => void;
  onNotNow: () => void; onDismiss: () => void;
}) {
  const view = cloudIntroView(offer);
  if (!view) return null;
  return <NoticeCard titleId="cloud-intro-title" notice="cloud-intro" icon={Cloud} title={t("cloudIntro.title")} onDismiss={onDismiss}>
    <p className="mt-2 inline-flex rounded-full bg-accent/15 px-2 py-0.5 text-[12px] font-medium text-accent-text">{view.badge}</p>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("cloudIntro.body")}</p>
    <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-ink">
      {view.points.map(point => <li key={point} className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />{point}</li>)}
    </ul>
    <p className="mt-2.5 text-[12px] text-ink-secondary">{view.price}</p>
    {view.moneyBack && <p className="text-[12px] text-ink-secondary">{view.moneyBack}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className={PRIMARY_BUTTON} onClick={onStart}>{t("cloudIntro.start")}</button>
      <button type="button" className="ui-button" onClick={onHowTo}>{t("cloudIntro.howTo")}</button>
    </div>
    <div className="mt-1 flex items-center justify-between gap-3">
      {onSignIn ? <button type="button" className="py-2 text-left text-[12px] font-medium text-accent-text underline underline-offset-2 hover:text-ink" onClick={onSignIn}>{t("cloudAccount.signIn")}</button> : <span />}
      <NotNowButton onClick={onNotNow} />
    </div>
  </NoticeCard>;
}
