import { useEffect, useState } from "react";
import { ArrowUpRight, CalendarClock, Cloud, Crown, Monitor, Sparkles, X } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, useStore, useStreaming } from "@/state/store";
import { openExternalLink, PRO_URL } from "@/lib/app-links";
import { emailGateDone } from "@/lib/analytics";
import { currentStep } from "@/lib/guided-tour";
import { hintSeen, hintSeenPatch, welcomeDue } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";

// Versioned once, for the launch price: a dismissal of the first card
// ("pro-introduction-dismissed") no longer counts, so everyone sees it once
// more. After that, updates and replaying the welcome tour never reset it.
export const PRO_DISMISSED = "pro-introduction-dismissed-v2";

/** The launch price, and the regular price shown struck through beside it. */
export const PRO_LAUNCH_PRICE = "$49";
export const PRO_REGULAR_PRICE = "$89";

export function proOfferAvailable(account: CloudAccountState | null): boolean {
  return account?.status === "signed-out" || (account?.status === "connected" && account.entitlement?.plan === "free");
}

function useProOffer() {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    // Reads the native snapshot only; never initiates sign-in or a refresh.
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return Boolean(bridge) && proOfferAvailable(account);
}

export function ProLink({ onOpened }: { onOpened?: () => void }) {
  const [failed, setFailed] = useState(false);
  return <div>
    <button type="button" className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={() => {
      setFailed(false);
      void openExternalLink(PRO_URL).then(onOpened).catch(() => setFailed(true));
    }}>
      {t("pro.getPro")}<ArrowUpRight size={14} aria-hidden="true" />
    </button>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("pro.openFailed")}</p>}
  </div>;
}

/** Always available in Settings, independent of the introduction's dismissal. */
export function ProSettingsCard() {
  const available = useProOffer();
  if (!available) return null;
  return <section aria-label={t("pro.name")} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
    <div className="flex items-center gap-3">
      <Crown className="text-ink-secondary" size={18} aria-hidden="true" />
      <div><h3 className="text-[14px] font-semibold text-ink">{t("pro.name")}</h3>
        <p className="mt-1 text-[12px] text-ink-secondary">{t("pro.settingsSummary")}</p></div>
    </div>
    <ProLink />
  </section>;
}

export function ProIntroductionCard({ onDismiss }: { onDismiss: () => void }) {
  return <aside aria-labelledby="pro-introduction-title" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
  }} className="fixed bottom-4 left-4 z-40 max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-hairline/40 bg-panel p-3.5 text-ink shadow-2xl shadow-black/20">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <Crown size={16} className="text-ink-secondary" aria-hidden="true" />
        <h2 id="pro-introduction-title" className="text-[13.5px] font-semibold">{t("pro.name")}</h2>
      </div>
      <button type="button" onClick={onDismiss} aria-label={t("pro.dismiss")} className="ui-icon-button"><X size={16} /></button>
    </div>
    <p className="mt-1 text-[12.5px] text-ink-secondary">{t("pro.headline")}</p>
    <ul className="my-3 space-y-2 text-[12.5px]">
      <li className="flex items-center gap-2.5"><Sparkles size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.priority")}</li>
      <li className="flex items-center gap-2.5"><Cloud size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.alwaysOn")}</li>
      <li className="flex items-center gap-2.5"><Monitor size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.computers")}</li>
      <li className="flex items-center gap-2.5"><CalendarClock size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("pro.schedule")}</li>
    </ul>
    <p className="mb-3 text-[12.5px]">
      <span role="img" aria-label={t("pro.launchPriceLabel", { was: PRO_REGULAR_PRICE, price: PRO_LAUNCH_PRICE })}>
        <s className="text-ink-secondary">{PRO_REGULAR_PRICE}</s> {t("pro.launchPrice", { price: PRO_LAUNCH_PRICE })}
      </span>
    </p>
    <div className="flex flex-wrap items-center gap-3">
      <ProLink onOpened={onDismiss} />
      <button type="button" className="py-2 text-[12px] text-ink-secondary hover:text-ink" onClick={onDismiss}>{t("pro.noThanks")}</button>
    </div>
    <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">{t("pro.disclaimer")}</p>
  </aside>;
}

export function ProIntroduction({ quiet = false }: { quiet?: boolean }) {
  const { state, dispatch } = useStore();
  const { streaming } = useStreaming();
  const available = useProOffer();
  const updater = useUpdaterState();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(PRO_DISMISSED) === "1"; } catch { return false; }
  });
  const record = state.config?.onboarding;
  const busy = state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId)
    || Object.keys(streaming).length > 0;
  const setup = state.welcomeOpen || state.tourOpen || (Boolean(record?.completedAt) && currentStep(record) !== null)
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone() });
  if (!available || dismissed || hintSeen(record, PRO_DISMISSED) || !state.connected || !state.config || setup || busy || quiet
    || state.appSettingsOpen || state.settingsOpen || state.newBotOpen || state.pluginsOpen || state.shortcutsOpen
    || (updater && !["idle", "checking"].includes(updater.status))) return null;

  const dismiss = () => {
    setDismissed(true);
    // Immediate device fallback plus the existing durable workspace hint record.
    // No expiry, version comparison, or marketing reminder timer.
    try { localStorage.setItem(PRO_DISMISSED, "1"); } catch { /* Workspace persistence remains available. */ }
    const patch = hintSeenPatch(record, PRO_DISMISSED);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  return <ProIntroductionCard onDismiss={dismiss} />;
}
