import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { HomeView, HomeBridge } from "../../electron/home-window.mjs";

const MACHINE: Record<string, LocaleKey> = {
  stopped: "cloudHome.stopped",
  "payment-problem": "cloudHome.paymentProblem",
  failed: "cloudHome.failed",
};
const UNREACHABLE: Record<string, LocaleKey> = { host: "cloudHome.unreachableHost", no_answer: "cloudHome.unreachable" };

/** The words for what the window is waiting on, and whether the person has anything to press. */
export function homeScreenText(view: HomeView | null): { title: string; body: string | null; reason: string | null; action: "sign-in" | "manage" | null; busy: boolean } {
  // A team's Cloud is named; My Cloud keeps its own words.
  const name = view?.name ?? null;
  const named = (plain: LocaleKey, withName: LocaleKey) => (name ? t(withName, { name }) : t(plain));
  if (view?.screen === "offline") return { title: named("homeScreen.offline", "homeScreen.offlineNamed"), body: t("homeScreen.offlineBack"), reason: view.cause && Object.hasOwn(UNREACHABLE, view.cause) ? t(UNREACHABLE[view.cause]!) : view.reason ?? null, action: null, busy: true };
  if (view?.screen === "signin") return { title: named("homeScreen.signIn", "homeScreen.signInNamed"), body: t(view.other ? "homeScreen.signInOther" : "homeScreen.signInEnded"), reason: null, action: "sign-in", busy: false };
  if (view?.screen === "plan") return { title: named("homeScreen.plan", "homeScreen.planNamed"), body: t(MACHINE[view.machine] ?? "cloudHome.failed"), reason: null, action: view.machine === "failed" ? null : "manage", busy: false };
  if (view?.screen === "waking") return { title: t("homeScreen.waking"), body: null, reason: null, action: null, busy: true };
  if (view?.screen === "moving") return { title: t("homeScreen.moving"), body: null, reason: null, action: null, busy: true };
  return { title: named("homeScreen.opening", "homeScreen.openingNamed"), body: null, reason: null, action: null, busy: true };
}

/**
 * This computer's own screen in the desktop window once the person's bots live on My Cloud: why My Cloud isn't open
 * yet, and nothing to do but wait, except Sign in when this device's sign-in has ended. It looks again by itself (main's
 * timer), when the network comes back and when the window comes to the front.
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
  return (
    <main data-home-screen={view?.screen ?? "opening"} className="flex min-h-screen items-center justify-center bg-app px-6 text-ink" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <div className="flex w-full max-w-[420px] flex-col items-start gap-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <p role="status" className="flex items-center gap-2 text-[20px] font-semibold">
          {text.busy && <span aria-hidden="true" className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-hairline border-t-accent" />}
          {text.title}
        </p>
        {text.body && <p className="text-[14px] leading-relaxed text-ink-secondary">{text.body}</p>}
        {text.reason && <p data-home-reason className="text-[13px] leading-relaxed text-ink-secondary">{text.reason}</p>}
        {text.action === "sign-in" && <button type="button" className="ui-button ui-button-primary mt-2" onClick={() => act(() => bridge.signIn())}>{t("homeScreen.signInButton")}</button>}
        {text.action === "manage" && manage && <button type="button" className="ui-button mt-2" onClick={() => act(manage)}>{t("cloudAccount.manageInBrowser")}</button>}
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
