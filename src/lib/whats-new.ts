import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { CLOUD_TEAM_TIERS } from "../../electron/cloud-team-plan.mjs";
import { track } from "@/lib/analytics";
import { cloudPlanView, moneyBackShort, offerPlanLabel, trialRunning, usd } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { WHATS_NEW_NOTICE } from "@/lib/notices";

export type WhatsNewSlide = "pro" | "team";
/** Who the account is to MausBot Cloud: no plan, a plan of its own, in a team, or something else (being bought, needing
 * attention, not checked). Null until the sign-in is restored and checked. */
export type WhatsNewAudience = "none" | "own" | "team" | "other";

/** Each slide's tag on the Cloud's funnel: `src` on its links, and `source` on the checkout the app opens from it. */
export const WHATS_NEW_SOURCES = { pro: "app_whats_new_pro", team: "app_whats_new_team" } as const satisfies Record<WhatsNewSlide, string>;
const CLOUD_SITE = "https://cloud.openmausbot.com", STAGING_SITE = "https://omb-cloud-staging.fly.dev";

/** The Cloud website's Home, which shows the plans to someone without one; `src` on /cloud opens that page. */
export const newCloudUrl = (staging = false) => `${staging ? STAGING_SITE : CLOUD_SITE}/cloud?src=${WHATS_NEW_SOURCES.pro}`;
/** The Team plan's checkout, as the website's Get Team opens it: its free trial while the Admin offers one. */
export const startTeamUrl = (staging = false) => `${staging ? STAGING_SITE : CLOUD_SITE}/pro/buy?plan=team&src=${WHATS_NEW_SOURCES.team}`;

const listedCloud = (account: CloudAccountState, team: boolean) =>
  (account.clouds ?? []).some(cloud => cloud.managed !== false && cloud.status !== "ended" && (cloud.teamId !== null) === team);

export function whatsNewAudience(account: CloudAccountState | null): WhatsNewAudience | null {
  const view = cloudPlanView(account);
  if (view.kind === "unknown" || view.kind === "connecting") return null;
  if (view.kind === "signed-out") return "none";
  if (account?.status !== "connected") return "other";
  if (account.teams?.length || CLOUD_TEAM_TIERS.includes(account.entitlement?.tier ?? "") || listedCloud(account, true)) return "team";
  if (view.kind === "paid") return "own";
  if (view.kind !== "free" || account.checkout || account.adding || trialRunning(account.trial) || listedCloud(account, false)) return "other";
  return "none";
}

/** No plan: the new Cloud, then Team. A plan of one's own: Team. Anyone in a team, or not known: nothing. */
export function whatsNewSlides(audience: WhatsNewAudience | null): WhatsNewSlide[] {
  return audience === "none" ? ["pro", "team"] : audience === "own" ? ["team"] : [];
}

export interface WhatsNewView {
  slides: WhatsNewSlide[];
  audience: "none" | "own";
  signedIn: boolean;
  staging: boolean;
  /** Each slide's plan in the Admin's words: its name, and its price line. */
  plans: Partial<Record<WhatsNewSlide, { name: string; terms: string }>>;
}

/** "loading" while the account or the offer is read; "none" when nothing is for this account now (a later launch may say
 * otherwise). A slide whose plan the Admin doesn't offer is left out. */
export function whatsNewView(account: CloudAccountState | null, offer: CloudOffer | null | undefined): WhatsNewView | "loading" | "none" {
  const audience = whatsNewAudience(account);
  if (audience === null) return "loading";
  if (audience !== "none" && audience !== "own") return "none";
  if (offer === undefined) return "loading";
  const wanted = whatsNewSlides(audience);
  const plans: WhatsNewView["plans"] = {};
  for (const slide of wanted) {
    const plan = offer?.plans.find(entry => entry.tier === slide);
    if (!plan) continue;
    const name = offerPlanLabel(plan), price = usd(plan.amount / 100);
    plans[slide] = { name, terms: slide === "team" && plan.trialDays ? t("cloudBuy.card.trial", { days: plan.trialDays, price })
      : [t("cloudBuy.pay.planPaid", { plan: name, price }), offer ? moneyBackShort(offer) : null].filter(Boolean).join(" · ") };
  }
  const slides = wanted.filter(slide => plans[slide]);
  if (!slides.length) return "none";
  return { slides, audience, signedIn: account?.status === "connected", staging: account?.staging === true, plans };
}

export type WhatsNewAction = "seen" | "next" | "back" | "get_pro" | "see_cloud" | "start_team" | "not_now" | "close";

export function reportWhatsNew(action: WhatsNewAction, slide: WhatsNewSlide, view: Pick<WhatsNewView, "audience" | "signedIn">) {
  track("whats_new", { action, slide, audience: view.audience === "own" ? "own_plan" : "no_plan", signed_in: view.signedIn, campaign: WHATS_NEW_NOTICE });
}
