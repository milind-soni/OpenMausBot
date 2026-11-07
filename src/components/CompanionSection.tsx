import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import {
  Cloud,
  Loader2,
  LogOut,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import type { CompanionAccountState } from "../types/ogb";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionAccountBridge,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionBridge,
  type CompanionRoute,
  type CompanionState,
  type PhoneSetupController,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { revealPhonePairing } from "../lib/phone-pairing";
import { PhonesList } from "./PhonesList";
import { PairedPhones, RelayLine } from "./PairedPhones";
import { ConnectionDetail } from "./ConnectionDetail";
import { Card, Switch } from "./SettingsPrimitives";
import { productName } from "../lib/brand";
import { useStore } from "@/state/store";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
};

export interface CompanionPanelStatus {
  label: string;
  good: boolean;
}

export interface TailscalePairingStatus {
  kind: "off" | "not-installed" | "signed-out" | "magicdns" | "waiting" | "ready" | "error";
  title: string;
  detail: string;
}

/** Any way in the person turned on; an older build's single switch reads as "on" while its sidecar runs. */
export const companionRoutesOn = (state: Pick<CompanionState, "enabled" | "routes">): boolean =>
  state.routes ? Object.values(state.routes).some((route) => route.on) : state.enabled;

export function deriveTailscalePairingStatus(
  state: Pick<CompanionState, "enabled" | "routes" | "tailscaleProblem" | "error">,
): TailscalePairingStatus {
  if (state.tailscaleProblem === "not-installed") return { kind: "not-installed", title: t("remote.tailscale.notInstalled"), detail: "" };
  if (state.tailscaleProblem === "no-cli") return { kind: "signed-out", title: t("remote.tailscale.noCli"), detail: "" };
  if (state.tailscaleProblem === "not-running") return { kind: "signed-out", title: t("remote.tailscale.notRunning"), detail: "" };
  if (state.tailscaleProblem === "needs-permission") return { kind: "signed-out", title: t("remote.tailscale.needsPermission", { app: productName() }), detail: "" };
  if (state.tailscaleProblem === "signed-out") return { kind: "signed-out", title: t("remote.tailscale.signIn"), detail: "" };
  if (state.error) return { kind: "error", title: t("remote.status.attention"), detail: state.error };
  const route = state.routes?.tailscale;
  if (!route?.on) return { kind: "off", title: t("remote.status.off"), detail: "" };
  if (!route.name) return { kind: "magicdns", title: t("remote.tailscale.magicDns"), detail: t("remote.tailscale.magicDnsDetail") };
  const title = t("remote.tailscale.ready", { name: route.name });
  return state.enabled
    ? { kind: "ready", title, detail: t("remote.tailscale.readyDetail") }
    : { kind: "waiting", title, detail: t("remote.tailscale.linkOff") };
}

/** Older app builds have no switch: on falls back to the check that turns it on, and off cannot be asked of them. */
export function setCompanionTailscale(companion: CompanionBridge, on: boolean): Promise<CompanionState> {
  if (companion.setTailscale) return companion.setTailscale(on);
  return on ? companion.refreshTailscale() : companion.state();
}

const NOTICE_KEY = {
  wifi: "remote.notice.wifi",
  relay: "remote.notice.relay",
  tailscale: "remote.notice.tailscale",
  https: "remote.notice.https",
} as const;

/** The update's one-time notes: each route it kept on, with Turn off beside OK. */
export function RouteNotices({ c, notices }: { c: PhoneSetupController; notices: CompanionRoute[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-route-notices="">
      {notices.map((route) => (
        <div key={route} role="status" data-route-notice={route} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-inset px-3 py-2.5 text-[13px] text-ink">
          <span className="min-w-0">{t(NOTICE_KEY[route])}</span>
          <span className="flex shrink-0 gap-2">
            <button type="button" disabled={c.busy} className="rounded-lg border border-hairline/40 px-2.5 py-1 text-[12px] hover:bg-control disabled:opacity-40"
              onClick={() => void c.act((companion) => (route === "tailscale" ? setCompanionTailscale(companion, false) : companion.setRoute?.(route, false) ?? companion.state()))}>
              {t("remote.notice.turnOff")}
            </button>
            <button type="button" disabled={c.busy} className="rounded-lg px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-40"
              onClick={() => void c.act((companion) => companion.dismissNotice?.(route) ?? companion.state())}>
              {t("common.ok")}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function pairingSurfaceCopy(
  route: Pick<PhoneSetupController, "localFallback" | "tailscaleFallback">,
): { title: string; subtitle: string } {
  if (route.tailscaleFallback) {
    return {
      title: t("remote.pairing.tailscale.title"),
      subtitle: t("remote.pairing.tailscale.subtitle"),
    };
  }
  if (route.localFallback) {
    return {
      title: t("remote.pairing.wifi.title"),
      subtitle: t("remote.pairing.wifi.subtitle"),
    };
  }
  return {
    title: t("remote.pairing.https.title"),
    subtitle: t("remote.pairing.https.subtitle"),
  };
}

export function deriveCompanionPanelStatus(
  state: Pick<CompanionState, "enabled" | "routes" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: t("remote.status.attention"), good: false };
  if (!companionRoutesOn(state)) return { label: t("remote.status.off"), good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: pairedCount === 1 ? t("remote.status.pairedOne") : t("remote.status.pairedMany", { count: pairedCount }),
    good: true,
  };
}

/** Opening this page is what brings a paused address back: no button. */
export function shouldResumePausedAddress(
  account: CompanionAccountState | null,
  state: Pick<CompanionState, "enabled" | "devices" | "error"> | null,
): boolean {
  return account?.paused === true && account.available && state?.enabled === true && !state.error && state.devices.length > 0;
}

export const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("remote.time.hours", { count: hours });
  return t("remote.time.days", { count: Math.round(hours / 24) });
};

const endpointHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function CompanionSection({ profileEmail = "", focusRequest = 0 }: { profileEmail?: string; focusRequest?: number }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const pairingFlow = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const loaded = Boolean(state);
  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(pairingFlow.current)) revealed.current = focusRequest;
  }, [focusRequest, loaded]);
  const resumeAsked = useRef(false);
  const resumePaused = shouldResumePausedAddress(c.account, state);
  const { accountAct } = c;
  useEffect(() => {
    if (!resumePaused || resumeAsked.current || !companionAccountBridge()?.prepare) return;
    resumeAsked.current = true;
    void accountAct((remote) => remote.prepare?.() ?? remote.state());
  }, [resumePaused, accountAct]);
  const managedPolicy = useStore().state.config?.managedPolicy;
  const remoteBlocked = managedPolicy?.remoteAccess === false ? t("policy.remoteBlocked", { organization: managedPolicy.organizationName }) : null;
  const managedBy = managedPolicy?.remoteAccess === false ? t("policy.managedBy", { organization: managedPolicy.organizationName }) : null;

  if (!companionBridge()) {
    return (
      <Card
        title={t("remote.desktopOnly.title", { app: productName() })}
        subtitle={t("remote.desktopOnly.subtitle")}
      />
    );
  }

  if (!state) {
    return (
      <Card title={t("remote.title")} subtitle={t("remote.checking")}>
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const pairedCount = state.devices.length;
  const panelStatus = deriveCompanionPanelStatus(state);
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const pairingCopy = pairingSurfaceCopy(c);
  const tailscaleStatus = deriveTailscalePairingStatus(state);
  const tailscaleOn = state.routes?.tailscale?.on === true;
  const routesOn = companionRoutesOn(state);
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const localRoutes = [
    state.tailnetName ? { label: "Tailscale", value: `${state.tailnetName}:${state.port}` } : null,
    state.lan ? { label: t("remote.connection.wifi"), value: `${state.lan}:${state.port}` } : null,
    state.discovery?.name
      ? { label: t("remote.connection.discovery"), value: `${state.discovery.name}:${state.port}` }
      : null,
    ...(state.addresses ?? [])
      .filter((address) => address !== state.lan && address !== state.tailscale)
      .map((address, index) => ({
        label: t("remote.connection.localRoute", { index: index + 1 }),
        value: `${address}:${state.port}`,
      })),
  ].filter((route): route is { label: string; value: string } => Boolean(route));

  return (
    <div className="flex flex-col gap-4">
      {remoteBlocked && <p role="status" className="text-[13px] leading-relaxed text-ink-secondary">{remoteBlocked}</p>}
      <RouteNotices c={c} notices={state.notices ?? []} />
      <div ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer" className="scroll-mt-4 rounded-xl ring-1 ring-accent/40 focus:outline-none">
        <Card title={pairingCopy.title} subtitle={pairingCopy.subtitle}>
          {(panelStatus || (pairedCount > 0 && c.hostedReady)) && (
            <div className="mb-4 flex items-center justify-between gap-3">
              {panelStatus && (
                <div
                  className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[12px] ${
                    panelStatus.good ? "bg-success/10 text-success" : "bg-control text-ink-secondary"
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${panelStatus.good ? "bg-success" : "bg-ink-secondary/50"}`} />
                  {panelStatus.label}
                </div>
              )}
              {pairedCount > 0 && c.hostedReady && (
                <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
                  <ShieldCheck size={13} className="text-accent" /> {t("remote.worksAway")}
                </div>
              )}
            </div>
          )}
          <PhoneSetupFlowView controller={c} />
        </Card>
      </div>

      <details className="rounded-xl border border-hairline/40 bg-card">
        <summary className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-ink">
          {t("remote.advanced")}
        </summary>
        <div className="flex flex-col gap-4 border-t border-hairline/30 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("remote.title")}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                <RelayLine state={state} fallback={t("remote.toggleDetail")} />
              </div>
            </div>
            <Switch
              checked={routesOn}
              aria-label={t("remote.title")}
              disabled={c.busy || (Boolean(remoteBlocked) && !routesOn)}
              onClick={() => void c.act((companion) => (routesOn ? companion.stop() : companion.start()))}
            />
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="text-[13px] text-ink">{t("remote.devices.title")}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{pairedCount ? t("remote.devices.subtitle", { app: productName() }) : t("remote.devices.empty")}</div>
            <div className="mt-3">
              <PairedPhones c={c} state={state} />
            </div>
          </div>

          <PhonesList />

          <div className="border-t border-hairline/30 pt-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">{t("remote.pairing.tailscale.title")}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("remote.tailscaleCard.subtitle")}</div>
                <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("remote.tailscaleSwitch.detail", { app: productName() })}</div>
              </div>
              <Switch
                checked={tailscaleOn}
                aria-label={t("remote.pairing.tailscale.title")}
                disabled={c.busy || c.accountBusy || (Boolean(managedBy) && !tailscaleOn)}
                onClick={() => void c.act((companion) => setCompanionTailscale(companion, !tailscaleOn))}
              />
            </div>
            {tailscaleStatus.kind !== "off" && (
              <div className="mt-3" data-tailscale-status={tailscaleStatus.kind}>
                <div className="rounded-xl bg-inset px-3 py-3" aria-live="polite">
                  <div className="flex items-start gap-2.5">
                    <ShieldCheck
                      size={16}
                      className={`mt-0.5 shrink-0 ${tailscaleStatus.kind === "ready" ? "text-success" : "text-ink-secondary"}`}
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink">{tailscaleStatus.title}</div>
                      {tailscaleStatus.detail && (
                        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                          {tailscaleStatus.detail}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(tailscaleStatus.kind === "ready" || tailscaleStatus.kind === "waiting") && (
                    <button
                      disabled={c.busy || c.accountBusy || Boolean(managedBy)}
                      title={managedBy ?? undefined}
                      onClick={() => {
                        c.useTailscale();
                        window.requestAnimationFrame(() => {
                          pairingFlow.current?.scrollIntoView({ block: "start" });
                          pairingFlow.current?.focus({ preventScroll: true });
                        });
                      }}
                      className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
                    >
                      {t("remote.pairOverTailscale")}
                    </button>
                  )}
                  {tailscaleOn && tailscaleStatus.kind !== "error" && (
                    <button
                      disabled={c.busy || c.accountBusy}
                      onClick={c.refreshTailscale}
                      className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
                    >
                      {c.busy ? t("common.checking") : t("remote.checkAgain")}
                    </button>
                  )}
                  {tailscaleStatus.kind === "not-installed" && (
                    <a href="https://tailscale.com/download" target="_blank" rel="noreferrer"
                      className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control">
                      {t("remote.tailscale.getIt")}
                    </a>
                  )}
                  {tailscaleStatus.kind === "signed-out" && (
                    <button
                      disabled={c.busy || c.accountBusy}
                      onClick={() => void c.act((companion) => setCompanionTailscale(companion, true))}
                      className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
                    >
                      {t("common.tryAgain")}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("remote.keepAwake")}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                {t("remote.keepAwakeDetail")}
              </div>
            </div>
            <Switch
              checked={state.keepAwake}
              aria-label={t("remote.keepAwakeAria")}
              disabled={c.busy || !routesOn}
              onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
            />
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <Cloud size={15} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">{t("remote.account.title")}</div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                    {c.account?.status === "ready"
                      ? t("remote.account.signedIn", {
                          email: c.account.email ?? t("remote.account.yourAccount"),
                        })
                      : c.account?.status === "connecting"
                        ? t("remote.account.connecting")
                        : c.account?.status === "error"
                          ? c.account.message ?? t("remote.account.error")
                          : t("remote.account.idle")}
                  </div>
                </div>
              </div>
              {(c.account?.status === "ready" || c.account?.status === "connecting" || c.account?.status === "error") && (
                <button
                  disabled={c.accountBusy}
                  onClick={() => void c.accountAct((remote) => remote.signOut())}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
                >
                  <LogOut size={12} /> {t("remote.account.signOut")}
                </button>
              )}
            </div>
            {c.account?.status === "error" && (
              <button
                disabled={c.accountBusy}
                onClick={c.retryAccount}
                className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
              >
                {c.accountBusy ? t("remote.account.retrying") : t("remote.account.retry")}
              </button>
            )}
            {accountActionError && <div className="mt-2 text-[12px] text-danger">{accountActionError}</div>}
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="text-[13px] text-ink">{t("remote.connection.title")}</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              {t("remote.connection.detail")}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {hosted && <ConnectionDetail label={t("remote.connection.secureRoute")} value={endpointHost(hosted.url)} />}
              {localRoutes.map((route) => <ConnectionDetail key={`${route.label}:${route.value}`} {...route} />)}
              {!hosted && localRoutes.length === 0 && (
                <div className="text-[12px] text-ink-secondary">{t("remote.connection.none")}</div>
              )}
            </div>
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="flex items-start gap-2.5">
              <Wifi size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div>
                <div className="text-[13px] text-ink">{t("remote.pairing.wifi.title")}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  {t("remote.wifi.detail")}
                </div>
              </div>
            </div>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useLocal}
              className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
            >
              {t("remote.wifi.pair")}
            </button>
          </div>

          {state.enabled && !hosted && !state.tailscale && (
            <div className="rounded-lg bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
              {t("remote.localOnly")}
            </div>
          )}
          {(c.error || state.error) && <div className="text-[12px] text-danger">{c.error ?? state.error}</div>}
        </div>
      </details>
    </div>
  );
}
