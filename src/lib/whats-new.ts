import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { CLOUD_TEAM_TIERS } from "../../electron/cloud-team-plan.mjs";
import { track } from "@/lib/analytics";
import { cloudPlanView, moneyBackShort, offerPlanLabel, trialRunning, trialTerms, usd } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { reportModelgoOffer, type ModelgoOfferAction } from "@/lib/modelgo-offer";
import { WHATS_NEW_NOTICE } from "@/lib/notices";
import type { TeamsAction } from "@/lib/teams-whats-new";

/** The plan slides, then the sponsor's. With the notice of "This computer and My Cloud together", its slide comes first,
 * and someone the plan slides don't sell to is told what is new instead: `cloudNews` for a Cloud they have, `teamNews` for a
 * team they are in. */
export type PlanSlide = "pro" | "team";
export type WhatsNewSlide = PlanSlide | "modelgo" | "together" | "cloudNews" | "teamNews";
/** Who the account is to MausBot Cloud: no plan, a plan of its own, in a team, or something else (being bought, needing
 * attention, not checked). Null until the sign-in is restored and checked. */
export type WhatsNewAudience = "none" | "own" | "team" | "other";

/** Each slide's tag on the Cloud's funnel: `src` on its links, and `source` on the checkout the app opens from it. */
export const WHATS_NEW_SOURCES = { pro: "app_whats_new_pro", team: "app_whats_new_team" } as const satisfies Record<PlanSlide, string>;
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
export function whatsNewSlides(audience: WhatsNewAudience | null): PlanSlide[] {
  return audience === "none" ? ["pro", "team"] : audience === "own" ? ["team"] : [];
}

/** The Team slide's main button: invite people to the team this page is, or start one, in the app's own Add a Cloud or on
 * the website. */
export type WhatsNewTeam = { kind: "invite"; url: string } | { kind: "start"; inApp: boolean };

export interface WhatsNewView {
  slides: WhatsNewSlide[];
  /** "other": whoever this page can't tell the Cloud plan of (a Cloud's page, a browser, a sign-in being bought or checked). */
  audience: "none" | "own" | "other";
  signedIn: boolean;
  staging: boolean;
  /** Each slide's plan in the Admin's words: its name, and its price line. */
  plans: Partial<Record<PlanSlide, { name: string; terms: string }>>;
  /** Without it, the Team slide starts a team: in the app for a plan of one's own, else on the website. */
  team?: WhatsNewTeam;
  /** The sponsor's slide offers Add key, which opens Settings where its key goes. */
  addKey?: boolean;
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
    plans[slide] = { name, terms: slide === "team" && plan.trialDays ? trialTerms(plan.trialDays, price)
      : [t("cloudBuy.pay.planPaid", { plan: name, price }), offer ? moneyBackShort(offer) : null].filter(Boolean).join(" · ") };
  }
  const slides = wanted.filter(slide => plans[slide]);
  if (!slides.length) return "none";
  return { slides, audience, signedIn: account?.status === "connected", staging: account?.staging === true, plans };
}

/**
 * Whether What's new carries the slide of "This computer and My Cloud together": where its corner notice would show (this
 * computer's own page, never a branded build's), while main calls it due (`due`, null until main answers) and it was
 * never drawn on screen before (`drawn`: an earlier launch showed the corner notice, which stays the one it gets). `kept`:
 * this page's carousel already showed the slide, which stays in it however main's answer reads now.
 */
export function togetherSlideDue({ here, due, drawn, kept }: { here: boolean; due: boolean | null; drawn: boolean; kept: boolean }): boolean | null {
  if (kept) return true;
  if (!here || due === false) return false;
  return due === null ? null : !drawn;
}

/**
 * What's new with all three slides, for everyone once: the new Cloud where `plans` (whatsNewView, "none" where this page
 * can't sell a plan) has it; Team where `team` starts or grows one (a member of a team is only told, so has no slide), unless
 * the Admin's offer was read and sells no Team plan (`teamSold` false); the sponsor's where `modelgo`.
 * `together` (togetherSlideDue): the notice of "This computer and My Cloud together" first, then the new Cloud and Team
 * again, though `seen` (What's new was seen already, which drops the sponsor's): for whom they sell nothing, what is new
 * on the Cloud they have (everyone with this notice has one) and in the team they are in.
 */
export function whatsNewCarousel({ plans, team, teamSold, modelgo, addKey, staging = false, together = false, seen = false }: {
  plans: WhatsNewView | "loading" | "none"; team: TeamsAction | null; teamSold?: boolean; modelgo: boolean; addKey: boolean; staging?: boolean;
  together?: boolean; seen?: boolean;
}): WhatsNewView | "loading" | "none" {
  if (seen && !together) return "none";
  if (plans === "loading") return "loading";
  const sold = typeof plans === "object" ? plans : null;
  const teamSlide: WhatsNewTeam | null = !team || team.kind === "got-it" || (team.kind === "start" && teamSold === false) ? null
    : team.kind === "invite" ? { kind: "invite", url: team.url } : { kind: "start", inApp: team.inApp };
  const slides: WhatsNewSlide[] = [
    ...(together ? ["together" as const] : []),
    ...(sold?.slides.includes("pro") ? ["pro" as const] : together ? ["cloudNews" as const] : []),
    ...(teamSlide ? ["team" as const] : together && team?.kind === "got-it" ? ["teamNews" as const] : []),
    ...(modelgo && !seen ? ["modelgo" as const] : []),
  ];
  if (!slides.length) return "none";
  const teamTerms = teamSlide?.kind !== "start" ? null : sold?.plans.team ?? { name: "Team", terms: t("teamsNew.price") };
  return {
    slides, audience: sold?.audience ?? "other", signedIn: sold?.signedIn ?? false, staging: sold?.staging ?? staging,
    plans: { ...(sold?.plans.pro && slides.includes("pro") ? { pro: sold.plans.pro } : {}), ...(teamTerms ? { team: teamTerms } : {}) },
    ...(teamSlide ? { team: teamSlide } : {}), addKey,
  };
}

export type WhatsNewAction = "seen" | "next" | "back" | "got_it" | "get_pro" | "see_cloud" | "start_team" | "invite" | "get_key" | "add_key" | "not_now" | "close";

const SPONSOR_STEPS: Partial<Record<WhatsNewAction, ModelgoOfferAction>> = { seen: "shown", get_key: "get_key", add_key: "add_key", not_now: "not_now", close: "close" };

/** Every step of every slide on `whats_new`; the sponsor's slide also on `modelgo_offer`, as its card was counted. */
export function reportWhatsNew(action: WhatsNewAction, slide: WhatsNewSlide, view: Pick<WhatsNewView, "audience" | "signedIn" | "team">, campaign: string = WHATS_NEW_NOTICE) {
  const audience = view.team?.kind === "invite" ? "team_admin" : view.audience === "own" ? "own_plan" : view.audience === "none" ? "no_plan" : "other";
  track("whats_new", { action, slide, audience, signed_in: view.signedIn, campaign });
  const sponsor = slide === "modelgo" ? SPONSOR_STEPS[action] : undefined;
  if (sponsor) reportModelgoOffer(sponsor, "popup", campaign);
}
