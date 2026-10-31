import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import type { CloudListEntry } from "../../electron/cloud-list.mjs";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
import { track } from "@/lib/analytics";
import { setLocale } from "@/lib/i18n";
import { WHATS_NEW_NOTICE } from "@/lib/notices";
import { newCloudUrl, reportWhatsNew, startTeamUrl, WHATS_NEW_SOURCES, whatsNewAudience, whatsNewSlides, whatsNewView, type WhatsNewView } from "./whats-new";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 12);
const OFFER: CloudOffer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500 }, { tier: "pro", label: "Pro", amount: 4900 }, { tier: "max", label: "Max", amount: 9900 },
  { tier: "team", label: "Team", amount: 16900, trialDays: 3 },
] };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const onPlan = (tier: string, extra: Partial<CloudAccountState> = {}): CloudAccountState =>
  ({ ...free, entitlement: { plan: "pro", tier, status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const listed = (patch: Partial<CloudListEntry>): CloudListEntry => ({ id: "c1", name: "My Cloud", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready",
  origin: "https://omb-c1.fly.dev", teamId: null, primary: true, managed: true, ...patch });
const team = { id: "t1", name: "Design Studio", role: "member" as const, machine: null };
const running = { state: "active" as const, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none" as const };

beforeEach(() => { setLocale("en"); vi.mocked(track).mockClear(); });

describe("who sees which slides", () => {
  it("no Cloud plan: the new Cloud, then Team; signed out or signed in with none, an ended Cloud of their own included", () => {
    for (const account of [{ status: "signed-out" } as CloudAccountState, free, { ...free, clouds: [listed({ status: "ended" })] },
      { ...free, clouds: [listed({ runsOn: "server", managed: false, tier: null })] }, { ...free, trial: { ...running, state: "ended" as const } }]) {
      expect(whatsNewAudience(account), JSON.stringify(account)).toBe("none");
      expect(whatsNewSlides(whatsNewAudience(account))).toEqual(["pro", "team"]);
    }
  });

  it("a Cloud plan of their own, in no team: the Team slide only, a trial on a personal plan included", () => {
    for (const account of [onPlan("starter"), onPlan("personal"), onPlan("pro"), onPlan("max"), onPlan("pro", { trial: running }), onPlan("pro", { clouds: [listed({})] })]) {
      expect(whatsNewAudience(account), JSON.stringify(account.entitlement)).toBe("own");
      expect(whatsNewSlides("own")).toEqual(["team"]);
    }
  });

  it("anyone in a team, owner or member, sees nothing: a team listed, a Team or Business plan, or a team's Cloud in the list", () => {
    const cases: CloudAccountState[] = [
      { ...free, teams: [team] }, { ...free, teams: [{ ...team, role: "owner" }] }, onPlan("pro", { teams: [team] }),
      onPlan("team"), onPlan("business"), { ...onPlan("team"), entitlement: { plan: "pro", tier: "team", status: "inactive", expiresAt: null, version: 3 } },
      { ...free, clouds: [listed({ teamId: "t1", tier: "team", role: "member", primary: false })] },
      onPlan("team", { trial: { ...running, tier: "team" } }),
    ];
    for (const account of cases) {
      expect(whatsNewAudience(account), JSON.stringify(account)).toBe("team");
      expect(whatsNewSlides(whatsNewAudience(account))).toEqual([]);
    }
  });

  it("nothing while a payment is linked or needs attention, a checkout or another Cloud is being bought, or the plan can't be checked", () => {
    const cases: CloudAccountState[] = [
      { ...free, purchase: { state: "confirming" } }, { ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 } },
      { ...free, checkout: { plan: "pro", startedAt: NOW } }, { ...free, clouds: [listed({ status: "checkout" })] },
      { ...free, clouds: [listed({ status: "payment_problem" })] },
      { status: "unavailable", lastPlan: { tier: "pro", active: true } }, { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } },
      { status: "reauth-required", message: "access-ended" }, { status: "signed-out", message: "restore-removed" },
    ];
    for (const account of cases) expect(whatsNewAudience(account), JSON.stringify(account)).toBe("other");
    expect(whatsNewSlides("other")).toEqual([]);
  });

  it("waits while the sign-in is restored or connects", () => {
    for (const account of [null, { status: "signed-out", message: "restoring" }, { status: "connecting" }] as const) {
      expect(whatsNewAudience(account as CloudAccountState | null)).toBeNull();
      expect(whatsNewView(account as CloudAccountState | null, OFFER)).toBe("loading");
    }
    expect(whatsNewSlides(null)).toEqual([]);
  });
});

describe("the slides' plans, from the Admin's offer", () => {
  it("names each plan with its price in the offer's numbers: Pro's money-back, Team's free trial", () => {
    expect(whatsNewView({ status: "signed-out" }, OFFER)).toEqual({ slides: ["pro", "team"], audience: "none", signedIn: false, staging: false,
      plans: { pro: { name: "Pro", terms: "Pro · $49/month + tax · 14-day money-back" }, team: { name: "Team", terms: "Free for 3 days, then $169/month + tax" } } });
    const priced: CloudOffer = { ...OFFER, refundDays: undefined, plans: OFFER.plans.map(plan => ({ ...plan, amount: plan.amount + 1000, trialDays: undefined })) };
    expect(whatsNewView(onPlan("pro", { staging: true }), priced)).toEqual({ slides: ["team"], audience: "own", signedIn: true, staging: true,
      plans: { team: { name: "Team", terms: "Team · $179/month + tax" } } });
  });

  it("leaves out a slide whose plan isn't sold, and shows nothing when neither is; waits for the offer, and offline waits for a later launch", () => {
    const noTeam = { ...OFFER, plans: OFFER.plans.filter(plan => plan.tier !== "team") };
    expect((whatsNewView(free, noTeam) as WhatsNewView).slides).toEqual(["pro"]);
    expect((whatsNewView(free, { ...OFFER, plans: OFFER.plans.filter(plan => plan.tier !== "pro") }) as WhatsNewView).slides).toEqual(["team"]);
    expect(whatsNewView(onPlan("pro"), noTeam)).toBe("none");
    expect(whatsNewView(free, undefined)).toBe("loading");
    expect(whatsNewView(free, null)).toBe("none");
    expect(whatsNewView(onPlan("team"), OFFER)).toBe("none");
    expect(whatsNewView(onPlan("team"), undefined), "nothing to wait for in a team").toBe("none");
  });
});

describe("the funnel", () => {
  it("each slide's links carry its own source tag, to the Cloud website or the staging Admin's", () => {
    expect(WHATS_NEW_SOURCES).toEqual({ pro: "app_whats_new_pro", team: "app_whats_new_team" });
    expect(newCloudUrl()).toBe("https://cloud.openmausbot.com/cloud?src=app_whats_new_pro");
    expect(startTeamUrl()).toBe("https://cloud.openmausbot.com/pro/buy?plan=team&src=app_whats_new_team");
    expect(newCloudUrl(true)).toBe("https://omb-cloud-staging.fly.dev/cloud?src=app_whats_new_pro");
    expect(startTeamUrl(true)).toBe("https://omb-cloud-staging.fly.dev/pro/buy?plan=team&src=app_whats_new_team");
    for (const tag of Object.values(WHATS_NEW_SOURCES)) expect(tag, "the Admin's tag form").toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it("counts each step with its slide, who it was for and the campaign; never an email, a name or an address", () => {
    reportWhatsNew("seen", "pro", { audience: "none", signedIn: false });
    reportWhatsNew("start_team", "team", { audience: "own", signedIn: true });
    expect(vi.mocked(track).mock.calls).toEqual([
      ["whats_new", { action: "seen", slide: "pro", audience: "no_plan", signed_in: false, campaign: WHATS_NEW_NOTICE }],
      ["whats_new", { action: "start_team", slide: "team", audience: "own_plan", signed_in: true, campaign: WHATS_NEW_NOTICE }],
    ]);
  });
});
