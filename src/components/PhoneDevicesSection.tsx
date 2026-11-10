import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import { Loader2, ShieldCheck } from "lucide-react";
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
import { PairedPhones } from "./PairedPhones";
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

/** The secure address was ended for old phone apps and a phone here still depends on it: say what to do, once. */
export function showTunnelRetiredNotice(
  account: Pick<CompanionAccountState, "tunnelRetired"> | null,
  state: Pick<CompanionState, "devices"> | null,
): boolean {
  return account?.tunnelRetired === true && Boolean(state?.devices.some((device) => !device.e2eAt));
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

const ROUTE_TEXT = {
  wifi: { name: "devices.route.wifi", detail: "devices.route.wifiDetail" },
  relay: { name: "devices.route.relay", detail: "devices.route.relayDetail" },
} as const;

const button = "rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40";

/** "On · since Nov 7", "On · waiting for a paired device", or "Off". */
export function routeStateText(route: { on: boolean; since: number | null } | undefined, paired: number): string {
  if (!route?.on) return t("devices.route.off");
  if (paired === 0) return t("devices.route.waiting");
  return route.since ? t("devices.route.onSince", { date: new Date(route.since).toLocaleDateString(undefined, { month: "short", day: "numeric" }) }) : t("devices.route.on");
}

function setRoute(companion: CompanionBridge, route: CompanionRoute, on: boolean): Promise<CompanionState> {
  if (route === "tailscale") return setCompanionTailscale(companion, on);
  return companion.setRoute?.(route, on) ?? (on ? companion.start([route]) : companion.state());
}

function RouteRow({ c, state, route, blocked }: { c: PhoneSetupController; state: CompanionState; route: "wifi" | "relay"; blocked: string | null }) {
  const current = state.routes?.[route];
  return (
    <div className="flex items-center justify-between gap-4 py-3" data-route-row={route}>
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{t(ROUTE_TEXT[route].name, { app: productName() })}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
          {routeStateText(current, state.devices.length)} · {t(ROUTE_TEXT[route].detail, { app: productName() })}
        </div>
      </div>
      <button type="button" className={button} disabled={c.busy || (Boolean(blocked) && !current?.on)} title={blocked ?? undefined}
        onClick={() => void c.act((companion) => setRoute(companion, route, !current?.on))}>
        {current?.on ? t("devices.route.turnOff") : t("devices.route.turnOn")}
      </button>
    </div>
  );
}

type PairStep = "consent" | "pairing";

/** Pair a device: says what it will turn on before anything listens, then shows the code. */
export function PairDeviceDialog({ c, state, onClose, secureAddress = false }: {
  c: PhoneSetupController;
  state: CompanionState;
  onClose: () => void;
  /** HTTPS address → Set up: the free web address, with its sign-in, before the code. */
  secureAddress?: boolean;
}) {
  const [picked, setPicked] = useState<Record<"wifi" | "relay", boolean>>({ wifi: true, relay: true });
  const needed: Array<"wifi" | "relay"> = ["wifi", "relay"];
  const anyOn = needed.some((route) => state.routes?.[route]?.on) || state.routes?.tailscale?.on === true;
  const [step, setStep] = useState<PairStep>(anyOn || secureAddress ? "pairing" : "consent");
  const { start } = c;
  useEffect(() => {
    if (secureAddress) start();
  }, [secureAddress, start]);
  const chosen = needed.filter((route) => picked[route]);
  const begin = async () => {
    for (const route of chosen) await c.act((bridge) => setRoute(bridge, route, true));
    setStep("pairing");
    c.useLocal();
  };
  const close = step === "consent" ? onClose : () => { c.cancel(); onClose(); };
  const root = useRef<HTMLDivElement>(null);
  // Out of Settings' tree, Settings no longer steps aside for this dialog: take Escape and Tab first, so Escape closes
  // only this dialog and Tab cycles through its controls instead of Settings'.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const box = root.current;
      if (!box || event.defaultPrevented || event.isComposing || (event.key !== "Escape" && event.key !== "Tab")) return;
      event.preventDefault();
      if (event.key === "Escape") { close(); return; }
      const controls = [...box.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((control) => control.getClientRects().length);
      if (!controls.length) return;
      const at = controls.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (event.shiftKey ? -1 : 0) : at + (event.shiftKey ? -1 : 1);
      controls.at(next % controls.length)!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);
  // Portalled to the body: inside Settings, the glass pane's backdrop-filter makes it the box `fixed` is measured
  // against, so the dialog was squeezed into that pane, see-through, and the QR was cut off when it scrolled.
  const dialog = (
    <div ref={root} role="dialog" aria-modal="true" aria-label={step === "consent" ? t("devices.pair.title") : t("devices.pair.titlePhone")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" data-pair-dialog={step}>
      <div className="flex max-h-full w-full max-w-[460px] flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-5 shadow-xl">
        <div className="text-[15px] font-semibold text-ink">{step === "consent" ? t("devices.pair.title") : t("devices.pair.titlePhone")}</div>
        {step === "consent" ? (
          <>
            <div className="flex flex-col gap-2 text-[13px] text-ink">
              <div>{t("devices.pair.willTurnOn", { app: productName() })}</div>
              {needed.map((route) => (
                <label key={route} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={picked[route]} onChange={(event) => setPicked((current) => ({ ...current, [route]: event.target.checked }))} />
                  <span>
                    {t(ROUTE_TEXT[route].name, { app: productName() })}
                    {route === "relay" && <span className="block text-[12px] text-ink-secondary">{t(ROUTE_TEXT.relay.detail, { app: productName() })}</span>}
                  </span>
                </label>
              ))}
              <div className="text-[12px] text-ink-secondary">{t("devices.pair.changeLater")}</div>
              {chosen.length === 0 && <div role="alert" className="text-[12px] text-danger">{t("devices.pair.pickOne")}</div>}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className={button} onClick={close}>{t("common.cancel")}</button>
              <button type="button" disabled={chosen.length === 0 || c.busy} onClick={() => void begin()}
                className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">{t("devices.route.turnOn")}</button>
            </div>
          </>
        ) : (
          <>
            <PhoneSetupFlowView controller={c} />
            <div className="text-[12px] leading-relaxed text-ink-secondary">{reachLine(state)}</div>
            <div className="flex justify-end">
              <button type="button" className={button} onClick={close}>{t("devices.pair.done")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

/** A pairing code still open: anyone holding it can pair until it runs out, so it can be revoked here. */
export function OpenCodeRow({ c, state }: { c: PhoneSetupController; state: CompanionState }) {
  const pairing = state.pairing;
  if (!pairing) return null;
  const until = new Date(pairing.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-card px-3 py-2.5" data-open-code="">
      <div className="min-w-0 text-[13px] text-ink">
        {t("devices.openCode", { until })}
      </div>
      <button type="button" className={button} disabled={c.busy}
        onClick={() => void c.act((companion) => companion.pairing(false, pairing.token))}>{t("devices.revoke")}</button>
    </div>
  );
}

/** "Reaches this computer on Same Wi-Fi and anywhere through MausBot." */
export function reachLine(state: Pick<CompanionState, "routes">): string {
  const on = (route: CompanionRoute) => state.routes?.[route]?.on === true;
  const ways = [
    on("wifi") && t("devices.reach.wifi"),
    on("tailscale") && t("devices.reach.tailscale"),
    on("https") && t("devices.reach.https", { app: productName() }),
    on("relay") && t("devices.reach.relay", { app: productName() }),
  ].filter((way): way is string => Boolean(way));
  if (ways.length === 0) return t("devices.reach.none");
  return t("devices.reach.line", { ways: new Intl.ListFormat(undefined, { type: "conjunction" }).format(ways) });
}

export function PhoneDevicesSection({ profileEmail = "", focusRequest = 0, simple = false }: { profileEmail?: string; focusRequest?: number; simple?: boolean }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const pairingFlow = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const loaded = Boolean(state);
  const [pairing, setPairing] = useState<false | "device" | "https">(false);
  const [showRoutes, setShowRoutes] = useState(!simple);
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

  if (!companionBridge()) return null;

  if (!state) {
    return (
      <Card title={t("devices.title")} subtitle={t("remote.checking")}>
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const pairedCount = state.devices.length;
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const tailscaleStatus = deriveTailscalePairingStatus(state);
  const tailscaleOn = state.routes?.tailscale?.on === true;
  const httpsOn = state.routes?.https?.on === true;
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const pairButton = (label: string) => (
    <button type="button" disabled={c.busy || Boolean(remoteBlocked)} title={managedBy ?? undefined} onClick={() => setPairing("device")}
      className="w-fit rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40" data-pair-device="">
      {label}
    </button>
  );

  if (simple && !showRoutes) {
    return (
      <div className="flex flex-col gap-3" ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer">
        <RouteNotices c={c} notices={state.notices ?? []} />
        {pairedCount === 0 ? (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-hairline/40 bg-card px-4 py-3">
            <div className="text-[13px] text-ink">{t("devices.simple.setUpTitle", { app: productName() })}</div>
            <button type="button" className={button} disabled={c.busy || Boolean(remoteBlocked)} onClick={() => setPairing("device")}>{t("devices.simple.setUp")}</button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-hairline/40 bg-card px-4 py-3">
            <div className="text-[13px] font-medium text-ink">{t("devices.simple.yourPhone")}</div>
            <PairedPhones c={c} state={state} />
            <div className="text-[12px] text-ink-secondary">
              {reachLine(state)}{" "}
              <button type="button" className="text-accent hover:underline" onClick={() => setShowRoutes(true)}>{t("devices.change")}</button>
            </div>
            {pairButton(t("devices.pairAnother"))}
          </div>
        )}
        {pairing && <PairDeviceDialog c={c} state={state} onClose={() => setPairing(false)} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer">
      {remoteBlocked && <p role="status" className="text-[13px] leading-relaxed text-ink-secondary">{remoteBlocked}</p>}
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("devices.intro")}</p>
      {pairButton(t("devices.pair"))}
      <RouteNotices c={c} notices={state.notices ?? []} />
      {pairing && <PairDeviceDialog c={c} state={state} onClose={() => setPairing(false)} secureAddress={pairing === "https"} />}

      <section className="flex flex-col gap-2" data-devices-block="paired">
        <div className="text-[13px] font-medium text-ink">{t("devices.paired")}</div>
        {showTunnelRetiredNotice(c.account, state) && (
          <p role="status" data-devices-notice="tunnel-retired" className="rounded-xl bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink">
            {t("remote.devices.retiredNotice")}
          </p>
        )}
        <OpenCodeRow c={c} state={state} />
        {pairedCount ? <PairedPhones c={c} state={state} /> : !state.pairing && <div className="text-[12px] text-ink-secondary">{t("devices.pairedNone")}</div>}
        <PhonesList />
      </section>

      <section className="flex flex-col rounded-xl border border-hairline/40 bg-card px-4" data-devices-block="routes">
        <div className="pt-3 text-[13px] font-medium text-ink">{t("devices.howTheyReach")}</div>
        <RouteRow c={c} state={state} route="wifi" blocked={managedBy} />
        <div className="border-t border-hairline/30"><RouteRow c={c} state={state} route="relay" blocked={managedBy} /></div>
        <details className="border-t border-hairline/30 py-3" open={tailscaleOn || httpsOn || undefined}>
          <summary className="cursor-pointer text-[13px] text-ink">{t("devices.moreWays")}</summary>
          <div className="mt-3 flex flex-col gap-4" data-route-row="tailscale">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">Tailscale</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("remote.tailscaleSwitch.detail", { app: productName() })}</div>
              </div>
              <button type="button" className={button} disabled={c.busy || c.accountBusy || (Boolean(managedBy) && !tailscaleOn)}
                onClick={() => void c.act((companion) => setCompanionTailscale(companion, !tailscaleOn))}>
                {tailscaleOn ? t("devices.route.turnOff") : t("devices.route.turnOn")}
              </button>
            </div>
            {tailscaleStatus.kind !== "off" && (
              <div data-tailscale-status={tailscaleStatus.kind} className="rounded-xl bg-inset px-3 py-3" aria-live="polite">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck size={16} className={`mt-0.5 shrink-0 ${tailscaleStatus.kind === "ready" ? "text-success" : "text-ink-secondary"}`} />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink">{tailscaleStatus.title}</div>
                    {tailscaleStatus.detail && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{tailscaleStatus.detail}</div>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {tailscaleOn && tailscaleStatus.kind !== "error" && (
                    <button type="button" className={button} disabled={c.busy || c.accountBusy} onClick={c.refreshTailscale}>
                      {c.busy ? t("common.checking") : t("remote.checkAgain")}
                    </button>
                  )}
                  {tailscaleStatus.kind === "not-installed" && (
                    <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className={button}>{t("remote.tailscale.getIt")}</a>
                  )}
                  {tailscaleStatus.kind === "signed-out" && (
                    <button type="button" className={button} disabled={c.busy || c.accountBusy} onClick={() => void c.act((companion) => setCompanionTailscale(companion, true))}>
                      {t("common.tryAgain")}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="flex items-start justify-between gap-4 border-t border-hairline/30 pt-4" data-route-row="https">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">{t("devices.route.https")}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  {httpsOn && hosted ? t("devices.route.httpsOn", { address: endpointHost(hosted.url) }) : routeStateText(state.routes?.https, pairedCount)}
                  {" · "}{t("devices.route.httpsDetail", { app: productName() })}
                </div>
                {c.account?.status === "ready" && (
                  <div className="mt-1 text-[12px] text-ink-secondary">{t("remote.account.signedIn", { email: c.account.email ?? t("remote.account.yourAccount") })}</div>
                )}
                {accountActionError && <div className="mt-1 text-[12px] text-danger">{accountActionError}</div>}
              </div>
              {httpsOn ? (
                <button type="button" className={button} disabled={c.busy} onClick={() => void c.act((companion) => setRoute(companion, "https", false))}>{t("devices.route.turnOff")}</button>
              ) : (
                <button type="button" className={button} disabled={c.busy || c.accountBusy || Boolean(managedBy)}
                  onClick={() => setPairing("https")}>{t("devices.route.setUp")}</button>
              )}
            </div>
          </div>
        </details>
      </section>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">{t("remote.keepAwake")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("remote.keepAwakeDetail")}</div>
        </div>
        <Switch checked={state.keepAwake} aria-label={t("remote.keepAwakeAria")} disabled={c.busy || !companionRoutesOn(state)}
          onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))} />
      </div>
      {simple && <button type="button" className="w-fit text-[12px] text-accent hover:underline" onClick={() => setShowRoutes(false)}>{t("devices.done")}</button>}
      {(c.error || state.error) && <div className="text-[12px] text-danger">{c.error ?? state.error}</div>}
    </div>
  );
}
