import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { AppsSection } from "./AppsSection";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { ServiceIcon } from "./ServiceIcon";

/** One app an admin made each person's own, as GET /api/team/my-connections lists it. */
export interface OwnApp { slug: string; name: string; connected: boolean; reconnect?: boolean }

const ACTION = "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40";

/** The Apps page for a Team Cloud's member: only the apps that are theirs to connect, used by their own private chats
 * alone. What the team's admins connect for everyone isn't theirs to change, so it isn't here. */
export function MemberApps() {
  const { state, dispatch } = useStore();
  const team = state.config?.team?.name ?? "";
  const [apps, setApps] = useState<OwnApp[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ slug: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const said = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const reads = useRef(0);
  const load = useCallback(() => {
    const read = ++reads.current;
    return api<{ apps?: OwnApp[] }>("/api/team/my-connections").then((answer) => {
      if (read !== reads.current) return;
      setApps(Array.isArray(answer.apps) ? answer.apps : []);
      setError(null);
    }, (cause) => {
      if (read !== reads.current) return;
      setApps((current) => current ?? []);
      said(cause);
    });
  }, []);
  const close = useCallback(() => dispatch({ type: "togglePlugins", open: false }), [dispatch]);
  useEffect(() => {
    void load();
    // An app's sign-in finishes in another tab: coming back to this one reads what it connected.
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); opener?.focus(); };
  }, [close]);

  const connect = async (app: OwnApp) => {
    const page = reserveConnectionPage();
    setBusy(app.slug); setError(null); setSignIn(null);
    try {
      const { url } = await api<{ url: string }>(`/api/team/my-connections/apps/${encodeURIComponent(app.slug)}/connect`, { method: "POST" });
      if (!await page.open(url)) setSignIn({ slug: app.slug, url });
    } catch (cause) {
      page.cancel();
      said(cause);
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async (app: OwnApp) => {
    setBusy(app.slug); setError(null);
    try {
      await api(`/api/team/my-connections/apps/${encodeURIComponent(app.slug)}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      said(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="glass-popup-frame" style={glassPopupFrameStyle()} onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div ref={dialog} data-member-apps role="dialog" aria-modal="true" aria-labelledby="member-apps-title" tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex max-w-[780px] flex-col overflow-hidden rounded-2xl">
        <header className="px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div className="flex items-center justify-between gap-3">
            <h2 id="member-apps-title" className="min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
            <button onClick={close} aria-label={t("common.close")} className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("memberApps.subtitle", { team })}</p>
        </header>
        <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-7 sm:px-7">
          {error && <div role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          {apps === null ? <div className="flex items-center justify-center py-16 text-ink-secondary"><Loader2 size={14} className="animate-spin" /></div>
            : apps.length === 0 ? <p data-member-apps-none className="py-10 text-center text-[13px] text-ink-secondary">{t("memberApps.none", { team })}</p>
            : <AppsSection id="member-apps-yours" title={t("memberApps.yours")}>
                {apps.map((app) => (
                  <div key={app.slug} data-app-tile={app.slug} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
                    <div className="flex items-center gap-3">
                      <ServiceIcon card={{ logo: null, domain: null, label: app.name }} className="size-10 shrink-0 rounded-[8px]" />
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="truncate text-[14px] font-semibold leading-5 text-ink">{app.name}</span>
                        {app.connected && !app.reconnect && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
                      </div>
                      <button type="button" disabled={busy !== null} className={ACTION}
                        onClick={() => void (app.connected && !app.reconnect ? disconnect(app) : connect(app))}>
                        {busy === app.slug ? <Loader2 size={14} className="animate-spin" />
                          : app.reconnect ? t("connectors.action.reconnect") : app.connected ? t("connectors.disconnect") : t("connectors.action.connect")}
                      </button>
                    </div>
                    {signIn?.slug === app.slug && <a href={signIn.url} target="_blank" rel="noopener noreferrer" className="ms-[52px] mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
                      {t("connectors.openAuthorizationPage")}
                    </a>}
                  </div>
                ))}
              </AppsSection>}
        </div>
      </div>
    </div>
  );
}
