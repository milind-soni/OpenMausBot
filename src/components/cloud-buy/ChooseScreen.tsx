// Screen 1: MausBot Cloud in a line, then the plans the Admin sells now as cards that show only what sets each apart,
// each with its own button; what every plan includes and the money are said once, under them.
import { useState } from "react";
import { AudioLines, ChevronDown, CloudUpload, HardDrive, Lock, Monitor, Moon, Power, Smartphone, Timer, type LucideIcon } from "lucide-react";
import type { CloudOffer, CloudOfferPlan } from "../../../electron/cloud-home.mjs";
import { cn } from "@/lib/cn";
import { cardRows, moneyBackShort, planCards, sharedTrialDays, trialTimeline, type CloudPlanCard, type CloudPlanCardRow } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { NightCard } from "./NightCard";
import { LINK, PRIMARY_WIDE, QUIET_WIDE, SCREEN, Tag } from "./parts";

const FEATURES: ReadonlyArray<readonly [LucideIcon, LocaleKey, LocaleKey]> = [
  [Moon, "cloudBuy.benefit.awayTitle", "cloudBuy.benefit.away"],
  [Lock, "cloudBuy.benefit.privateTitle", "cloudBuy.benefit.private"],
  [Smartphone, "cloudBuy.benefit.anywhereTitle", "cloudBuy.benefit.anywhere"],
  [Monitor, "cloudBuy.benefit.browserTitle", "cloudBuy.benefit.browser"],
  [CloudUpload, "cloudBuy.benefit.moveTitle", "cloudBuy.benefit.move"],
];
const ROW_ICON: Partial<Record<CloudPlanCardRow["key"], LucideIcon>> = { power: Power, hours: Timer, storage: HardDrive, voice: AudioLines };

/** Cards side by side on a wide sheet, written out for Tailwind to find. */
const COLUMNS: Record<number, string> = { 1: "md:grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-2 lg:grid-cols-4" };

const detailsId = (tier: string) => `cloud-plan-details-${tier}`;

/** On a wide sheet the cards share their rows (a subgrid), so every card's price, numbers and button line up. */
function PlanCard({ card, shown, details, compare, busy, onStart }: {
  card: CloudPlanCard; shown: CloudPlanCardRow[]; details: CloudPlanCardRow[]; compare: boolean; busy: boolean; onStart: (tier: string) => void;
}) {
  const nameId = `cloud-plan-${card.tier}`;
  return <li data-plan={card.tier} aria-labelledby={nameId} data-plan-current={card.current ? "" : undefined}
    className={cn("grid min-w-0 grid-rows-subgrid gap-y-3 rounded-[14px] border-[0.5px] bg-menu p-4", compare ? "row-span-5" : "row-span-4",
      card.popular ? "border-ink/25" : "border-ink/10")}>
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <h4 id={nameId} className="text-[15px] font-medium leading-[22px] text-ink">{card.name}</h4>
      {card.popular && <Tag data-plan-popular="">{t("cloudAdd.popular")}</Tag>}
    </div>
    <div className="flex flex-col gap-1.5">
      <p className="flex items-baseline gap-1">
        <span className="text-[28px] font-semibold leading-8 tracking-[-0.02em] tabular-nums text-ink">{card.price}</span>
        <span className="text-[13px] text-ink-tertiary">{t("cloudBuy.perMonth")}</span>
      </p>
      {card.promise && <p data-plan-promise="" className="text-[13px] leading-[18px] text-ink-secondary">{card.promise}</p>}
    </div>
    <ul className="flex flex-col gap-2.5 pt-1">
      {shown.map(row => {
        const Icon = ROW_ICON[row.key];
        return <li key={row.key} data-plan-row={row.key} className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 text-[13px] leading-[18px] text-ink">
          {Icon ? <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="mt-px text-ink-tertiary" /> : <span />}
          <span>{row.text}{row.note && <small className="block text-[12px] leading-4 text-ink-tertiary">{row.note}</small>}</span>
        </li>;
      })}
    </ul>
    <ul id={detailsId(card.tier)} hidden={!compare} className="flex flex-col gap-2 border-t-[0.5px] border-ink/10 pt-4 text-[12px] leading-4 text-ink-secondary">
      {details.map(row => <li key={row.key} data-plan-row={row.key}>
        {row.text}{row.note && <small className="block text-[12px] leading-4 text-ink-tertiary">{row.note}</small>}
      </li>)}
    </ul>
    <div className="flex flex-col gap-2 self-start pt-1">
      {card.action
        ? <button type="button" data-plan-buy={card.tier} aria-describedby={nameId} className={card.popular ? PRIMARY_WIDE : QUIET_WIDE} disabled={busy}
          onClick={() => onStart(card.tier)}>{card.action}</button>
        : <p data-plan-mine="" className="grid min-h-9 place-items-center rounded-full bg-ink/[0.04] px-4 text-[14px] text-ink-secondary">{t("cloudBuy.card.current")}</p>}
      {card.terms && <p className="text-center text-[12px] leading-4 text-ink-tertiary">{card.terms}</p>}
    </div>
  </li>;
}

export function ChooseScreen({ offer, current = null, own = null, now, busy, signedOut, notice, onStart, onSignIn }: {
  offer: CloudOffer;
  /** The person's own plan tier, and that plan when it is no longer on sale: its card says Your plan instead of a button. */
  current?: string | null; own?: CloudOfferPlan | null;
  now: number; busy: boolean; signedOut: boolean; notice: string | null;
  onStart: (tier: string) => void; onSignIn: () => void;
}) {
  const [compare, setCompare] = useState(false);
  const cards = planCards(offer, { current, own });
  const rows = cardRows(cards);
  const timeline = trialTimeline(offer, now);
  const moneyBack = moneyBackShort(offer);
  const trial = Boolean(sharedTrialDays(offer));
  return <div data-cloud-add={offer.plans.some(plan => plan.trialDays) ? "offer-trial" : "offer"} className={SCREEN}>
    <div className="-mx-4 -mt-3">
      <NightCard>
        <h2 id="cloud-add-title" tabIndex={-1} className="text-[17px] font-medium leading-6 tracking-[-0.008em] outline-none!">{t("pro.name")}</h2>
        <p className="mt-0.5 max-w-[440px] text-[14px] leading-5 text-(--cloud-night-ink-quiet) [text-wrap:pretty]">
          <span className="font-medium text-(--cloud-night-ink)">{t("cloudBuy.title")}</span> {t("cloudBuy.lede")}
        </p>
        <button type="button" aria-expanded={compare} aria-controls={cards.map(card => detailsId(card.tier)).join(" ")} onClick={() => setCompare(!compare)}
          className="-ms-2 mt-2 inline-flex items-center gap-1 self-start rounded-full py-0.5 pe-1.5 ps-2 text-[13px] leading-[18px] text-(--cloud-night-ink-quiet) transition-colors hover:bg-white/10 hover:text-(--cloud-night-ink) motion-reduce:transition-none">
          {t("pro.seePlans")}<ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", compare && "rotate-180")} />
        </button>
      </NightCard>
    </div>
    {notice && <p role="status" className="rounded-[12px] bg-ink/[0.04] px-4 py-3 text-[13px] leading-[18px] text-ink">{notice}</p>}
    <section aria-labelledby="cloud-add-plans">
      <h3 id="cloud-add-plans" className="sr-only">{t("cloudBuy.choose")}</h3>
      <ul aria-labelledby="cloud-add-plans" className={cn("grid gap-3", COLUMNS[cards.length] ?? "md:grid-cols-3")}>
        {cards.map((card, index) => <PlanCard key={card.tier} card={card} shown={rows[index]!.shown} details={rows[index]!.details} compare={compare} busy={busy} onStart={onStart} />)}
      </ul>
    </section>
    <div aria-live="polite" className="flex flex-col gap-1.5 text-[13px] leading-[18px] text-ink-secondary">
      {timeline.length > 1 && <ol aria-label={t("cloudBuy.timeline")} className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {timeline.map((step, index) => <li key={step.when} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", index === 0 ? "bg-ink" : "border border-ink/40")} />
          <b className="font-medium text-ink">{step.when}</b>{step.text}
        </li>)}
      </ol>}
      {(trial || moneyBack) && <p className="flex flex-wrap gap-x-1.5">
        {trial && <span>{t("cloudBuy.trialTerms")}</span>}{trial && moneyBack && <span aria-hidden="true">·</span>}{moneyBack && <span>{moneyBack}</span>}
      </p>}
    </div>
    <section aria-labelledby="cloud-add-includes" className="flex flex-col gap-2.5">
      <h3 id="cloud-add-includes" className="text-[13px] font-medium leading-[18px] text-ink-secondary">{t("cloudBuy.includes")}</h3>
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {FEATURES.map(([Icon, title, body]) => <li key={title} className="flex text-[13px] leading-[18px] text-ink">
          <span aria-hidden="true" title={t(body)} className="inline-flex items-center gap-1.5">
            <Icon size={16} strokeWidth={1.5} className="shrink-0 text-ink-tertiary" />{t(title)}
          </span>
          <span className="sr-only">{t(title)}: {t(body)}</span>
        </li>)}
      </ul>
    </section>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t-[0.5px] border-ink/10 pt-4 text-[12px] leading-4 text-ink-tertiary">
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="inline-flex items-center gap-1.5"><Lock size={13} strokeWidth={1.5} aria-hidden="true" />{t("cloudBuy.secure")}</span>
        <span role="img" aria-label={t("cloudBuy.wallets")} className="inline-flex gap-1">
          {[t("cloudBuy.applePay"), t("cloudBuy.googlePay"), t("cloudBuy.card")].map(mark => <span key={mark} aria-hidden="true"
            className="rounded-[5px] border-[0.5px] border-ink/20 px-1.5 py-px text-[11px] font-medium text-ink-secondary">{mark}</span>)}
        </span>
        <span aria-hidden="true">·</span><span>{t("cloudBuy.cancelEasy")}</span>
      </p>
      {signedOut && <button type="button" className={LINK} onClick={onSignIn}>{t("cloudBuy.haveAccount")}</button>}
    </div>
  </div>;
}
