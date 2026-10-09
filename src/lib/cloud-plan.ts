// What the app says about the person's OMB Cloud plan, in one place: Settings
// → OMB Cloud, the Pro card in Settings and the Pro introduction all read it,
// so no two of them can disagree. The rule the owner set: after buying,
// nothing unexpected or contradictory, never an offer to buy to someone who
// pays (or may pay: an unknown state is not "free"), and every state has one
// message and one next step.
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { t } from "@/lib/i18n";

const PLAN_LABEL: Record<string, string> = { personal: "Personal", pro: "Pro", max: "Max" };
/** A paid plan's product name. No tier is an Admin that sells only Pro; a
 * tier newer than this app reads "Cloud". */
export function cloudPlanLabel(tier?: string): string {
  return tier === undefined ? "Pro" : Object.hasOwn(PLAN_LABEL, tier) ? PLAN_LABEL[tier] : "Cloud";
}

export type CloudPlanView =
  /** Not known yet: no snapshot, or a saved sign-in still being read. */
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "connecting" }
  /** Verified: signed in, no plan, no Cloud, no payment being linked. */
  | { kind: "free" }
  /** Verified and active. `checking`: the last checks failed; this is the last verified answer. */
  | { kind: "paid"; label: string; checking: boolean }
  /** A plan that is not active (a payment problem, or it ended) or a Cloud still there without one. */
  | { kind: "attention"; label: string | null }
  /** A payment OMB Cloud received and is linking to this account. */
  | { kind: "purchase"; label: string | null; paidAt?: number }
  /** OMB Cloud cannot be asked right now. `label`: the plan last verified. */
  | { kind: "unverified"; label: string | null }
  /** This computer's sign-in ended. The plan is unaffected. */
  | { kind: "reauth"; label: string | null; reason: "expired" | "access-ended" };

export function cloudPlanView(account: CloudAccountState | null | undefined): CloudPlanView {
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return { kind: "unknown" };
  const last = account.lastPlan ? cloudPlanLabel(account.lastPlan.tier) : null;
  if (account.status === "signed-out") return { kind: "signed-out" };
  if (account.status === "connecting") return { kind: "connecting" };
  if (account.status === "reauth-required") return { kind: "reauth", label: last, reason: account.message === "expired" ? "expired" : "access-ended" };
  if (account.status !== "connected") return { kind: "unverified", label: last };
  const entitlement = account.entitlement;
  if (entitlement?.plan === "pro" && entitlement.status === "active") return { kind: "paid", label: cloudPlanLabel(entitlement.tier), checking: account.checking === true };
  if (account.purchase) {
    return { kind: "purchase", label: account.purchase.tier ? cloudPlanLabel(account.purchase.tier) : null, ...(account.purchase.paidAt ? { paidAt: account.purchase.paidAt } : {}) };
  }
  // A lapsed plan, or a Cloud still there (a payment problem, stopped): never "free", never a new purchase.
  if (entitlement?.plan === "pro") return { kind: "attention", label: cloudPlanLabel(entitlement.tier) };
  if (account.machine) return { kind: "attention", label: null };
  return { kind: "free" };
}

/** Only these two may see an offer to buy: nobody who pays, may pay, or
 * whose state is unknown. Signed out, the offer leads with signing in. */
export function buyOfferAllowed(view: CloudPlanView): boolean {
  return view.kind === "signed-out" || view.kind === "free";
}

/** What the X research card offers someone whose server has no plan
 * credential yet: a paying desktop is still connecting it; signed out (or a
 * sign-in that ended), sign in; verified free, get a plan. Nothing where the
 * state is unknown or someone may already pay, and without a desktop bridge. */
export function xResearchAction(view: CloudPlanView | null): "connecting" | "sign-in" | "get-pro" | null {
  if (!view) return null;
  if (view.kind === "paid") return "connecting";
  if (view.kind === "signed-out" || view.kind === "reauth") return "sign-in";
  return view.kind === "free" ? "get-pro" : null;
}

/** The plan in one line, or null where there is no plan to name. */
export function cloudPlanLine(view: CloudPlanView): string | null {
  switch (view.kind) {
    case "paid": return t("cloudAccount.pro", { plan: view.label });
    case "attention": return t("cloudAccount.inactive", { plan: view.label ?? "OpenMausBot Cloud" });
    case "purchase": return t("cloudAccount.purchaseReceived", { plan: view.label ?? "OpenMausBot Cloud" });
    case "unverified": return view.label ? t("cloudAccount.lastPlan", { plan: view.label }) : null;
    case "reauth": return view.label ? t("cloudAccount.planName", { plan: view.label }) : null;
    case "free": return t("cloudAccount.free");
    default: return null;
  }
}
