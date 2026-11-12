import { useEffect, useState } from "react";
import type { CloudAccountState, CloudPlanSnapshot } from "../../../electron/cloud-account.mjs";
import { cloudPlanLabel, cloudPlanView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { profileForSession, readSessionState, type SessionState } from "@/lib/session";
import { useStore } from "@/state/store";

export interface AccountSummary {
  /** read from the account bridge, the plan bridge or the server session; null until it answers */
  signedIn: boolean | null;
  email: string | null;
  /** "Pro", "Free"; null where this page can't read the plan */
  plan: string | null;
  paid: boolean;
}

function fromAccount(account: CloudAccountState | null): AccountSummary {
  const view = cloudPlanView(account);
  if (!account || view.kind === "unknown") return { signedIn: null, email: null, plan: null, paid: false };
  const signedIn = ["connected", "unavailable", "reauth-required"].includes(account.status);
  const email = signedIn && "account" in account ? account.account?.email ?? null : null;
  const plan = view.kind === "paid" ? view.label : view.kind === "free" ? t("settings.account.free") : signedIn ? null : null;
  return { signedIn, email, plan, paid: view.kind === "paid" };
}

function fromPlan(plan: CloudPlanSnapshot | null): AccountSummary {
  if (!plan) return { signedIn: null, email: null, plan: null, paid: false };
  const paid = plan.status === "paid";
  return { signedIn: plan.status !== "none" && plan.status !== "signin", email: null, plan: paid ? cloudPlanLabel(plan.tier) : null, paid };
}

/** Who is signed in to MausBot on this device, as far as this page may know. */
export function useAccountSummary(): AccountSummary {
  const account = typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const planBridge = account ? undefined : typeof window === "undefined" ? undefined : window.ogb?.cloudPlan;
  const [summary, setSummary] = useState<AccountSummary>({ signedIn: null, email: null, plan: null, paid: false });
  useEffect(() => {
    let alive = true;
    if (account) {
      const off = account.onState((next) => { if (alive) setSummary(fromAccount(next)); });
      void account.state().then((next) => { if (alive) setSummary(fromAccount(next)); }).catch(() => {});
      return () => { alive = false; off(); };
    }
    if (planBridge) {
      void planBridge.state().then((next) => { if (alive) setSummary(fromPlan(next)); }).catch(() => {});
      return () => { alive = false; };
    }
    return () => { alive = false; };
  }, [account, planBridge]);
  return summary;
}

/** The name and photo the chrome shows for you, and the server session they came from. */
export function useYou(): { profile: { name?: string; email?: string; avatarUrl?: string } | undefined; session: SessionState | null } {
  const { state } = useStore();
  const [session, setSession] = useState<SessionState | null>(null);
  useEffect(() => {
    let alive = true;
    void readSessionState().then((next) => { if (alive) setSession(next); });
    return () => { alive = false; };
  }, []);
  return { profile: profileForSession(state.config?.profile, session), session };
}

/** "Pro · ada@example.com", "Not signed in"; in a browser, "Signed in to My Cloud". */
export function accountLine(summary: AccountSummary, { browser, place, openSource }: { browser: boolean; place: string; openSource: boolean }): string {
  if (browser) return t("settings.account.signedInTo", { place });
  if (openSource) return t("settings.account.onThisDevice");
  if (summary.signedIn === false) return t("settings.account.notSignedIn");
  return [summary.plan, summary.email].filter(Boolean).join(" · ") || t("settings.account.signedIn");
}
