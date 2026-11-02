import { useEffect, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { HomeView, HomeBridge } from "../../electron/home-window.mjs";
import { CloudSetupSteps } from "./CloudSetupSteps";

const MACHINE: Record<string, LocaleKey> = {
  stopped: "cloudHome.stopped",
  "payment-problem": "cloudHome.paymentProblem",
  failed: "cloudHome.failed",
};

/** What the screen's one button does: sign in again, open the Plan page, look again, or, for a Cloud that isn't running, buy
 * it again, continue its checkout or update the card (each on the Cloud page in the browser, or its checkout reopened). */
export type HomeAction = "sign-in" | "manage" | "retry" | "buy" | "continue" | "card";

/** A day as this person reads it: "November 1", with the year once it isn't this one. */
export function homeDay(at: number, now = Date.now()): string {
  const year = new Date(at).getFullYear() !== new Date(now).getFullYear();
  return new Intl.DateTimeFormat(activeLocale(), { day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}) }).format(new Date(at));
}

/** The words for what the window is waiting on, and whether the person has anything to press. */
export function homeScreenText(view: HomeView | null, now = Date.now()): { title: string; body: string | null; reason: string | null; action: HomeAction | null; busy: boolean } {
  // A team's Cloud is named; My Cloud keeps its own words.
  const name = view?.name ?? null;
  const named = (plain: LocaleKey, withName: LocaleKey) => (name ? t(withName, { name }) : t(plain));
  if (view?.screen === "setup") return { title: named("homeScreen.setup", "homeScreen.setupNamed"), body: t(view.slow ? "cloudHome.slow" : "homeScreen.setupBody"), reason: null, action: null, busy: true };
  // It didn't answer: said once, with Try again, never a spinner that goes on for ever (it still looks again by itself).
  if (view?.screen === "offline") return { title: named("homeScreen.offline", "homeScreen.offlineNamed"), body: t("homeScreen.offlineBack"), reason: view.reason ?? null, action: "retry", busy: false };
  if (view?.screen === "signin") return { title: named("homeScreen.signIn", "homeScreen.signInNamed"), body: t(view.other ? "homeScreen.signInOther" : "homeScreen.signInEnded"), reason: null, action: "sign-in", busy: false };
  if (view?.screen === "plan") return { title: named("homeScreen.plan", "homeScreen.planNamed"), body: t(MACHINE[view.machine] ?? "cloudHome.failed"), reason: null, action: view.machine === "failed" ? null : "manage", busy: false };
  // A Cloud the Admin's list says isn't running: what it is in plain words, with its one fitting action.
  if (view?.screen === "ended") return { title: named("cloudHome.ended", "cloudHome.endedNamed"), body: view.deleteAt ? t("cloudHome.endedFiles", { date: homeDay(view.deleteAt, now) }) : null,
    reason: null, action: "buy", busy: false };
  if (view?.screen === "checkout") return { title: named("cloudHome.checkout", "cloudHome.checkoutNamed"), body: null, reason: null, action: "continue", busy: false };
  if (view?.screen === "payment") return { title: named("cloudHome.payment", "cloudHome.paymentNamed"), body: t("cloudHome.paymentBody"), reason: null, action: "card", busy: false };
  if (view?.screen === "waking") return { title: t("homeScreen.waking"), body: null, reason: null, action: null, busy: true };
  if (view?.screen === "moving") return { title: named("homeScreen.moving", "homeScreen.movingNamed"), body: null, reason: null, action: null, busy: true };
  return { title: named("homeScreen.opening", "homeScreen.openingNamed"), body: null, reason: null, action: null, busy: true };
}

const BUTTON: Record<Exclude<HomeAction, "sign-in" | "manage">, LocaleKey> = {
  retry: "cloudHome.tryAgain", buy: "cloudHome.buyAgain", continue: "cloudHome.continue", card: "cloudHome.updateCard",
};

/** Remove from list on this screen: asked first, in plain words; then the window goes on without that Cloud. */
function RemoveFromList({ name, remove }: { name: string; remove: () => Promise<string> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<"refused" | "failed" | null>(null);
  const confirm = () => {
    setBusy(true); setSaid(null);
    void remove().then((outcome) => { setBusy(false); if (outcome !== "removed" && outcome !== "gone") { setAsking(false); setSaid(outcome === "refused" ? "refused" : "failed"); } },
      () => { setBusy(false); setAsking(false); setSaid("failed"); });
  };
  return <div data-home-remove className="flex flex-col items-start gap-2">
    {asking
      ? <div role="alertdialog" aria-label={t("rail.remove")} className="flex flex-col gap-2 rounded-xl border border-hairline/70 bg-card/70 px-4 py-3">
        <p className="text-[13px] leading-relaxed text-ink">{t("rail.removeAsk", { name })}</p>
        <div className="flex gap-2">
          <button type="button" data-home-remove-confirm className="ui-button ui-button-primary" disabled={busy} onClick={confirm}>{t("rail.removeYes")}</button>
          <button type="button" className="ui-button" disabled={busy} onClick={() => setAsking(false)}>{t("rail.removeNo")}</button>
        </div>
      </div>
      : <button type="button" data-home-remove-ask className="text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline" onClick={() => { setSaid(null); setAsking(true); }}>{t("rail.remove")}</button>}
    {said && <p role="alert" className="text-[13px] text-danger">{t(said === "refused" ? "rail.removeRefused" : "rail.removeFailed")}</p>}
  </div>;
}

/**
 * This computer's own screen in the desktop window while a place can't be shown (My Cloud once it is home, or asked for while
 * the Admin sets it up, a team's Cloud, or another Cloud of the person's own): why, in plain words, and at most one thing to
 * press: Sign in when this device's sign-in has ended, Try again when it didn't answer, or, for a Cloud that isn't running,
 * Buy again, Continue or Update your card, with Remove from list for one its owner may take off their list. It looks again by
 * itself (main's timer), when the network comes back and when the window comes to the front.
 */
export function HomeScreen({ bridge, manage }: { bridge: HomeBridge; manage?: () => Promise<void> }) {
  const [view, setView] = useState<HomeView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const stop = bridge.onState((next) => setView(next));
    const again = () => { void bridge.retry().then((next) => { if (alive) setView(next); }).catch(() => {}); };
    // Landing here any way at all (this computer's frozen copy answers every page with this screen) asks main to open home.
    void bridge.state().then((next) => { if (alive) setView(next); }).catch(() => {}).then(again);
    window.addEventListener("online", again);
    window.addEventListener("focus", again);
    return () => { alive = false; stop(); window.removeEventListener("online", again); window.removeEventListener("focus", again); };
  }, [bridge]);
  const text = homeScreenText(view);
  const act = (action: () => Promise<unknown>) => { setFailed(false); void action().catch(() => setFailed(true)); };
  // Its checkout's page again when this app keeps it (the Cloud it is buying), else the Cloud page, where it can be paid.
  const reopen = window.ogb?.cloudAdd?.reopen;
  const run: Partial<Record<HomeAction, () => Promise<unknown>>> = {
    retry: () => bridge.retry().then((next) => setView(next)),
    ...(manage ? { manage, buy: manage, card: manage, continue: async () => { if (!(reopen && await reopen().catch(() => false))) await manage(); } } : {}),
  };
  const button = text.action && text.action !== "sign-in" && text.action !== "manage" ? text.action : null;
  const removable = (view?.screen === "ended" || view?.screen === "payment") && view.removable === true && typeof bridge.remove === "function";
  return (
    <main data-home-screen={view?.screen ?? "opening"} className="flex min-h-screen items-center justify-center bg-app px-6 text-ink" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <div className="flex w-full max-w-[420px] flex-col items-start gap-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <p role="status" className="flex items-center gap-2 text-[20px] font-semibold">
          {text.busy && <span aria-hidden="true" className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-hairline border-t-accent" />}
          {text.title}
        </p>
        {text.body && <p className="text-[14px] leading-relaxed text-ink-secondary">{text.body}</p>}
        {view?.screen === "setup" && <CloudSetupSteps step={view.step ?? "reserving"} />}
        {text.reason && <p data-home-reason className="text-[13px] leading-relaxed text-ink-secondary">{text.reason}</p>}
        {text.action === "sign-in" && <button type="button" className="ui-button ui-button-primary mt-2" onClick={() => act(() => bridge.signIn())}>{t("homeScreen.signInButton")}</button>}
        {text.action === "manage" && manage && <button type="button" className="ui-button mt-2" onClick={() => act(manage)}>{t("cloudAccount.manageInBrowser")}</button>}
        {button && run[button] && <button type="button" data-home-action={button} className={button === "retry" ? "ui-button mt-2" : "ui-button ui-button-primary mt-2"}
          onClick={() => act(run[button]!)}>{t(BUTTON[button])}</button>}
        {removable && <RemoveFromList name={view.name ?? t("cloudSetup.myCloud")} remove={() => bridge.remove!()} />}
        {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
      </div>
    </main>
  );
}

/** My Cloud's own page in the desktop window, once its session there ended: the app signs it in again by itself, so
 * the page never asks for a code. Anywhere else (a browser, another server) the sign-in page shows as before. */
export function SignedOutAtHome({ bridge, fallback }: { bridge: Pick<HomeBridge, "repair">; fallback: React.ReactNode }) {
  const [refused, setRefused] = useState(false);
  useEffect(() => { void bridge.repair().catch(() => setRefused(true)); }, [bridge]);
  if (refused) return <>{fallback}</>;
  return (
    <main data-home-screen="opening" className="flex min-h-screen items-center justify-center bg-app px-6 text-ink">
      <p role="status" className="w-full max-w-[420px] text-[20px] font-semibold">{t("homeScreen.opening")}</p>
    </main>
  );
}
