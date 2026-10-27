// Screen 1: what MausBot Cloud is, then the plans the Admin sells now as cards, each with its own button, and the money in one line.
import { Check, CloudUpload, Lock, Monitor, Moon, Smartphone, type LucideIcon } from "lucide-react";
import type { CloudOffer, CloudOfferPlan } from "../../../electron/cloud-home.mjs";
import { cn } from "@/lib/cn";
import { moneyBackShort, planCards, sharedTrialDays, trialTimeline, type CloudPlanCard } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { CloudMascotScene } from "./CloudMascotScene";
import { LINK, PRIMARY_WIDE } from "./parts";

const BENEFITS: ReadonlyArray<readonly [LucideIcon, LocaleKey, LocaleKey]> = [
  [Moon, "cloudBuy.benefit.awayTitle", "cloudBuy.benefit.away"],
  [Lock, "cloudBuy.benefit.privateTitle", "cloudBuy.benefit.private"],
  [Smartphone, "cloudBuy.benefit.anywhereTitle", "cloudBuy.benefit.anywhere"],
  [Monitor, "cloudBuy.benefit.browserTitle", "cloudBuy.benefit.browser"],
  [CloudUpload, "cloudBuy.benefit.moveTitle", "cloudBuy.benefit.move"],
];

/** Cards side by side on a wide sheet, written out for Tailwind to find; four go two by two. */
const COLUMNS: Record<number, string> = { 1: "md:grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-2" };

/** On a wide sheet the cards share their rows (a subgrid), so every card's button and list start at the same height. */
function PlanCard({ card, busy, onStart }: { card: CloudPlanCard; busy: boolean; onStart: (tier: string) => void }) {
  const nameId = `cloud-plan-${card.tier}`;
  return <li data-plan={card.tier} aria-labelledby={nameId} data-plan-current={card.current ? "" : undefined}
    className={cn("row-span-6 grid min-w-0 grid-rows-subgrid gap-y-3 rounded-2xl border bg-card p-5", card.popular ? "border-accent" : "border-hairline")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 id={nameId} className="text-[16px] font-semibold text-ink">{card.name}</h4>
      {card.popular && <span data-plan-popular className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold tracking-[0.02em] text-accent-ink">{t("cloudAdd.popular")}</span>}
    </div>
    <p className="flex items-baseline gap-1">
      <span className="text-[32px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">{card.price}</span>
      <span className="text-[13px] font-medium text-ink-tertiary">{t("cloudBuy.perMonth")}</span>
    </p>
    <p data-plan-promise className="text-[13px] leading-snug text-ink-secondary">{card.promise}</p>
    {card.action
      ? <button type="button" data-plan-buy={card.tier} aria-describedby={nameId} className={PRIMARY_WIDE} disabled={busy} onClick={() => onStart(card.tier)}>{card.action}</button>
      : <p data-plan-mine className="grid min-h-11 place-items-center rounded-xl border border-hairline bg-raised text-[14px] font-semibold text-ink-secondary">{t("cloudBuy.card.current")}</p>}
    <p className="-mt-1.5 text-center text-[12px] leading-snug text-ink-tertiary">{card.terms}</p>
    <ul className="flex flex-col gap-2 border-t border-hairline/60 pt-3">
      {card.rows.map(row => <li key={row.key} data-plan-row={row.key} className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2 text-[13px] leading-snug text-ink">
        <Check size={14} aria-hidden="true" className="mt-0.5 text-accent-text" />
        <span>{row.text}{row.note && <small className="block text-[11px] text-ink-tertiary">{row.note}</small>}</span>
      </li>)}
    </ul>
  </li>;
}

export function ChooseScreen({ offer, current = null, own = null, now, busy, signedOut, notice, onStart, onSignIn }: {
  offer: CloudOffer;
  /** The person's own plan tier, and that plan when it is no longer on sale: its card says Your plan instead of a button. */
  current?: string | null; own?: CloudOfferPlan | null;
  now: number; busy: boolean; signedOut: boolean; notice: string | null;
  onStart: (tier: string) => void; onSignIn: () => void;
}) {
  const cards = planCards(offer, { current, own });
  const timeline = trialTimeline(offer, now);
  const moneyBack = moneyBackShort(offer);
  return <div data-cloud-add={offer.plans.some(plan => plan.trialDays) ? "offer-trial" : "offer"} className="flex flex-col">
    <div className="grid gap-x-6 gap-y-[18px] border-b border-hairline/60 bg-linear-to-b from-accent/15 via-accent/[0.04] to-transparent px-7 pb-5 pt-6 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)] md:items-center">
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-accent-text">{t("pro.name")}</p>
        <h2 id="cloud-add-title" tabIndex={-1} className="mb-1.5 mt-1 pe-8 text-[27px] font-bold leading-[1.12] tracking-[-0.025em] text-ink outline-none [text-wrap:balance]">{t("cloudBuy.title")}</h2>
        <p className="max-w-[44ch] text-[14px] leading-relaxed text-ink-secondary">{t("cloudBuy.lede")}</p>
      </div>
      <div className="md:me-8 md:mt-4"><CloudMascotScene variant="hero" /></div>
      <ul aria-label={t("cloudBuy.benefits")} className="grid gap-3 sm:grid-cols-2 md:col-span-2 md:grid-cols-5">
        {BENEFITS.map(([Icon, title, body]) => <li key={title} className="grid grid-cols-[26px_minmax(0,1fr)] items-start gap-2">
          <span aria-hidden="true" className="grid size-[26px] place-items-center rounded-[8px] bg-accent/12 text-accent-text"><Icon size={15} /></span>
          <span><span className="block text-[13px] font-semibold leading-snug text-ink">{t(title)}</span><span className="block text-[12px] leading-snug text-ink-secondary">{t(body)}</span></span>
        </li>)}
      </ul>
    </div>
    <div className="flex min-w-0 flex-col gap-4 px-7 pb-5 pt-5">
      <h3 id="cloud-add-plans" className="text-[15px] font-semibold text-ink">{t("cloudBuy.choose")}</h3>
      {notice && <p role="status" className="text-[13px] text-ink">{notice}</p>}
      <ul aria-labelledby="cloud-add-plans" className={cn("grid gap-3", COLUMNS[cards.length] ?? "md:grid-cols-3")}>
        {cards.map(card => <PlanCard key={card.tier} card={card} busy={busy} onStart={onStart} />)}
      </ul>
      {sharedTrialDays(offer) && <div aria-live="polite" className="flex flex-col gap-2 rounded-xl border border-hairline/70 bg-card/70 px-4 py-3">
        <p className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudBuy.trialTerms")}</p>
        {timeline.length > 1 && <ol aria-label={t("cloudBuy.timeline")} className="relative mt-1 grid" style={{ gridTemplateColumns: `repeat(${timeline.length}, minmax(0, 1fr))` }}>
          <span aria-hidden="true" className="absolute inset-x-1.5 top-[6px] h-0.5 bg-hairline" />
          {timeline.map((step, index) => {
            const last = index === timeline.length - 1, first = index === 0;
            return <li key={step.when} className={cn("relative min-w-0 pt-[18px] text-[12px] leading-snug text-ink-secondary", !first && !last && "text-center", last && "text-end")}>
              <span aria-hidden="true" className={cn("absolute top-px size-3 rounded-full border-2", first ? "start-0 border-accent bg-accent" : "border-ink-tertiary bg-panel",
                !first && !last && "start-[calc(50%-6px)]", last && "end-0")} />
              <b className="block text-[12px] font-semibold text-ink">{step.when}</b>{step.text}
            </li>;
          })}
        </ol>}
      </div>}
      <div className="flex flex-col items-center gap-1.5 text-center text-[12px] text-ink-tertiary">
        <p className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5"><Lock size={13} aria-hidden="true" />{t("cloudBuy.secure")}</span>
          <span role="img" aria-label={t("cloudBuy.wallets")} className="inline-flex gap-1">
            {[t("cloudBuy.applePay"), t("cloudBuy.googlePay"), t("cloudBuy.card")].map(mark => <span key={mark} aria-hidden="true"
              className="rounded-[5px] border border-hairline px-[5px] py-px text-[11px] font-semibold text-ink-secondary">{mark}</span>)}
          </span>
        </p>
        <p className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1">
          <span>{t("cloudBuy.cancelEasy")}</span>{moneyBack && <span>{moneyBack}</span>}
        </p>
        {signedOut && <button type="button" className={LINK} onClick={onSignIn}>{t("cloudBuy.haveAccount")}</button>}
      </div>
    </div>
  </div>;
}
