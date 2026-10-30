// Screen 3: the browser has the payment page; this sheet shows where things stand and moves on by itself.
import { Copy, ExternalLink } from "lucide-react";
import type { CloudOffer } from "../../../electron/cloud-home.mjs";
import { cloudPlanLabel, dueToday, offerPlanLabel, usd } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { Checklist, Heading, LINK, PRIMARY, QUIET, SCREEN } from "./parts";

export function PayScreen({ plan, offer, browser, late, link, email, busy, copied, failed, onReopen, onCopy, onChangePlan }: {
  plan: string; offer: CloudOffer | null; browser: "checkout" | "signin"; late: boolean; link: boolean; email: string | null;
  busy: boolean; copied: boolean; failed: boolean; onReopen: () => void; onCopy: () => void; onChangePlan: () => void;
}) {
  const sold = offer?.plans.find(entry => entry.tier === plan) ?? null;
  const name = sold ? offerPlanLabel(sold) : cloudPlanLabel(plan);
  const detail = sold?.trialDays ? t("cloudBuy.pay.planTrial", { plan: name, days: sold.trialDays, due: dueToday(0) })
    : sold ? t("cloudBuy.pay.planPaid", { plan: name, price: usd(sold.amount / 100) }) : name;
  return <div data-cloud-add={late ? "waiting-late" : browser === "signin" ? "waiting-signin" : "waiting"} className={SCREEN}>
    <Heading title={late ? t("cloudBuy.pay.lateTitle") : t("cloudAdd.browserTitle")}
      sub={late ? t("cloudBuy.pay.lateSub") : t(browser === "signin" ? "cloudBuy.pay.subSignIn" : "cloudBuy.pay.sub")} />
    <Checklist items={[
      { key: "signed-in", state: "done", title: t("cloudBuy.pay.signedIn"), detail: email },
      { key: "payment", state: "now", title: t("cloudBuy.pay.waiting"), detail },
      { key: "setup", state: "next", title: t("cloudBuy.pay.setup"), detail: t("cloudBuy.pay.setupHint") },
    ]} />
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={late ? PRIMARY : QUIET} disabled={busy} onClick={onReopen}>
        <ExternalLink size={14} aria-hidden="true" />{t("cloudAdd.reopenCheckout")}</button>
      {link && <button type="button" className={QUIET} disabled={busy} onClick={onCopy}><Copy size={14} aria-hidden="true" />{t("cloudBuy.pay.copy")}</button>}
      <button type="button" className={`${LINK} ms-1 px-1 py-1`} onClick={onChangePlan}>{t("cloudAdd.changePlan")}</button>
    </div>
    <div aria-live="polite" className="text-[13px] leading-[18px] empty:-mt-5">
      {copied && <p className="text-ink-secondary">{t("cloudBuy.pay.copied")}</p>}
      {failed && <p role="alert" className="text-danger">{t("cloudBuy.pay.failed")}</p>}
    </div>
  </div>;
}
