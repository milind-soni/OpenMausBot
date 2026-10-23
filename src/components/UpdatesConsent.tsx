import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import type { UpdatesConsentBridge, UpdatesConsentState, UpdatesConsentStatus } from "../../electron/updates-consent.mjs";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

export const UPDATES_CONSENT_POPUP = "[data-updates-consent-popup]";
const TITLE = "updates-consent-title";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRIMARY = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const SECONDARY = "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-[14px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function updatesConsentBridge(): UpdatesConsentBridge | undefined {
  return window.ogb?.remoteClient?.active === true ? undefined : window.ogb?.updatesConsent;
}

function readable(value: unknown): UpdatesConsentState | null {
  const state = value as Partial<UpdatesConsentState> | null | undefined;
  return state && typeof state.available === "boolean" && typeof state.due === "boolean" ? state as UpdatesConsentState : null;
}

/** `undefined` while main answers; null without a bridge, or for a page main does not answer: nothing is asked or shown then. */
export function useUpdatesConsent(bridge: UpdatesConsentBridge | undefined) {
  const [state, setState] = useState<UpdatesConsentState | null | undefined>(undefined);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.state().then(next => { if (active) setState(readable(next)); }, () => { if (active) setState(null); });
    return () => { active = false; };
  }, [bridge]);
  const choose = async (status: UpdatesConsentStatus, email?: string) => {
    if (!bridge) return;
    const next = readable(await bridge.choose({ status, ...(email ? { email } : {}) }));
    if (next) setState(next);
  };
  return { state: bridge ? state : null, choose };
}

/** The question itself. Nothing is pre-ticked or pre-filled: only "Yes" opts in. */
export function UpdatesConsentDialog({ signedIn, onYes, onNo }: {
  signedIn: boolean;
  onYes: (email: string | undefined) => Promise<void>;
  onNo: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { document.getElementById(TITLE)?.focus(); }, []);
  const yes = () => {
    const typed = email.trim();
    if (!signedIn && typed && !EMAIL.test(typed)) { setError(t("updatesConsent.badEmail")); return; }
    setBusy(true); setError(null);
    void onYes(signedIn || !typed ? undefined : typed).catch(() => { setBusy(false); setError(t("updatesConsent.failed")); });
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onNo(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby="updates-consent-body" data-updates-consent-popup="" tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); onNo(); } }}
      className="relative max-h-full w-full max-w-[400px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 text-ink shadow-2xl outline-none">
      <div className="flex items-center gap-2.5">
        <Mail size={18} className="shrink-0 text-accent-text" aria-hidden="true" />
        <h2 id={TITLE} tabIndex={-1} className="text-[17px] font-semibold outline-none">{t("updatesConsent.title")}</h2>
      </div>
      <p id="updates-consent-body" className="mt-3 text-[13.5px] leading-relaxed text-ink-secondary">{t("updatesConsent.body")}</p>
      {!signedIn && <label className="mt-4 flex flex-col gap-1.5 text-[13px] font-medium">
        {t("updatesConsent.email")}
        <input type="email" value={email} autoComplete="email" placeholder="you@example.com" disabled={busy} onChange={event => { setEmail(event.target.value); setError(null); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); yes(); } }}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] font-normal text-ink placeholder:text-ink-secondary focus:outline-none" />
        <span className="text-[12px] font-normal text-ink-secondary">{t("updatesConsent.emailHint")}</span>
      </label>}
      {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={SECONDARY} disabled={busy} onClick={onNo}>{t("updatesConsent.no")}</button>
        <button type="button" className={PRIMARY} disabled={busy} onClick={yes}>{t("updatesConsent.yes")}</button>
      </div>
    </div>
  </div>;
}

/** Settings → General: on exactly when this computer's answer (or the signed-in account's) is "opted_in". */
export function UpdatesConsentRow() {
  const bridge = updatesConsentBridge();
  const { state, choose } = useUpdatesConsent(bridge);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!state?.available) return null;
  const on = state.status === "opted_in";
  const set = (status: UpdatesConsentStatus, email?: string) => {
    setBusy(true); setFailed(false);
    return choose(status, email).catch(error => { setFailed(true); throw error; }).finally(() => setBusy(false));
  };
  const subtitle = <>
    {t("settings.updatesConsent.subtitle")}
    {on && state.email && <>{" "}{t("settings.updatesConsent.to", { email: state.email })}</>}
  </>;
  return <SettingRow title={t("settings.updatesConsent.title")} subtitle={subtitle}
    message={failed ? <span role="alert" className="text-danger">{t("updatesConsent.failed")}</span> : undefined}>
    <Switch checked={on} disabled={busy} aria-label={t("settings.updatesConsent.aria")}
      onClick={() => {
        if (on) void set("withdrawn").catch(() => {});
        else if (state.signedIn) void set("opted_in").catch(() => {});
        else setAsking(true);
      }} />
    {asking && <UpdatesConsentDialog signedIn={false} onNo={() => setAsking(false)}
      onYes={async email => { await set("opted_in", email); setAsking(false); }} />}
  </SettingRow>;
}
