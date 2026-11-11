import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { ChevronRight, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/cn";
import { openExternalLink } from "@/lib/app-links";
import { PHONE_APPS } from "./PhoneAppDialog";
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
import { revealPhonePairing, takePairOnOpen } from "../lib/phone-pairing";
import { showTunnelRetiredNotice } from "../lib/phone-link";
import { PhonesList } from "./PhonesList";
import { PairedPhones } from "./PairedPhones";
import { TailnetComputers } from "./TailnetComputers";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows, Switch } from "./SettingsPrimitives";
import { Layer } from "./Layer";
import { productName } from "../lib/brand";
import { useStore } from "@/state/store";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  showTunnelRetiredNotice,
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

const ROUTE_TEXT = {
  wifi: { name: "devices.route.wifi", detail: "devices.route.wifiDetail" },
  relay: { name: "devices.route.relay", detail: "devices.route.relayDetail" },
} as const;


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

const ROUTE_LINE = { wifi: "phone.reach.wifiLine", relay: "phone.reach.anywhereLine" } as const;

function RouteRow({ c, state, route, blocked }: { c: PhoneSetupController; state: CompanionState; route: "wifi" | "relay"; blocked: string | null }) {
  const current = state.routes?.[route];
  const inert = Boolean(blocked) && !current?.on;
  return (
    <SettingRow title={t(ROUTE_TEXT[route].name, { app: productName() })} subtitle={t(ROUTE_LINE[route])}
      message={current?.on ? routeStateText(current, state.devices.length) : inert ? blocked : undefined}>
      <span data-route-row={route} className="contents">
        <Switch checked={current?.on === true} aria-label={t(ROUTE_TEXT[route].name, { app: productName() })} disabled={c.busy || inert} title={blocked ?? undefined}
          onClick={() => void c.act((companion) => setRoute(companion, route, !current?.on))} />
      </span>
    </SettingRow>
  );
}

type PairStep = "consent" | "pairing";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Pair a device: says what it will turn on before anything listens, then shows the code. */
export function PairDeviceDialog({ c, state, onClose, secureAddress = false, placeName = t("rail.thisComputer") }: {
  c: PhoneSetupController;
  state: CompanionState;
  onClose: () => void;
  placeName?: string;
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
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = root.current;
    if (box && !box.contains(document.activeElement)) box.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  // Settings also handles Escape and Tab; capture them first so they act on this dialog only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const box = root.current;
      if (!box || event.defaultPrevented || event.isComposing || (event.key !== "Escape" && event.key !== "Tab")) return;
      event.preventDefault();
      if (event.key === "Escape") { close(); return; }
      const controls = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((control) => control.getClientRects().length);
      if (!controls.length) return;
      const at = controls.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (event.shiftKey ? -1 : 0) : at + (event.shiftKey ? -1 : 1);
      controls.at(next % controls.length)!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);
  // An ancestor with backdrop-filter becomes the containing block for `fixed`, so it renders through Layer, on the body.
  const title = t("phone.pair.dialogTitle", { place: placeName });
  const dialog = (
    <div ref={root} role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" data-pair-dialog={step} data-settings-look="simple">
      <div className="flex max-h-full w-full max-w-[440px] flex-col gap-4 overflow-y-auto rounded-2xl border-[0.5px] border-(--settings-edge) bg-app p-6 shadow-xl">
        <div className="text-[16px] font-semibold leading-[22px] text-ink">{title}</div>
        {step === "consent" ? (
          <>
            <p className="text-[13px] leading-[18px] text-ink-secondary">{t("phone.pair.howReach")}</p>
            <div className="flex flex-col rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu" data-settings-rows="">
              {needed.map((route) => (
                <label key={route} className="flex min-h-11 cursor-pointer items-center gap-6 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[14px] leading-5 text-ink">{t(ROUTE_TEXT[route].name, { app: productName() })}</span>
                    <span className="text-[13px] leading-[18px] text-ink-secondary">{t(ROUTE_LINE[route])}</span>
                  </span>
                  <Switch checked={picked[route]} aria-label={t(ROUTE_TEXT[route].name, { app: productName() })}
                    onClick={() => setPicked((current) => ({ ...current, [route]: !current[route] }))} />
                </label>
              ))}
            </div>
            {chosen.length === 0 && <div role="alert" className="text-[12px] leading-4 text-danger">{t("devices.pair.pickOne")}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="ui-button" onClick={close}>{t("common.cancel")}</button>
              <button type="button" disabled={chosen.length === 0 || c.busy} onClick={() => void begin()} className="ui-button ui-button-primary" data-pair-turn-on="">{t("phone.pair.turnOnShow")}</button>
            </div>
          </>
        ) : (
          <>
            <PhoneSetupFlowView controller={c} />
            <div className="text-[12px] leading-4 text-ink-secondary">{reachLine(state)}</div>
            <div className="flex justify-end">
              <button type="button" className="ui-button ui-button-primary" onClick={close}>{t("devices.pair.done")}</button>
            </div>
          </>
        )}
        <p className="text-[12px] leading-4 text-ink-secondary">{t("phone.pair.foot")}</p>
      </div>
    </div>
  );
  return <Layer modal>{dialog}</Layer>;
}

/** A pairing code still open: anyone holding it can pair until it runs out, so it can be revoked here. */
export function OpenCodeRow({ c, state }: { c: PhoneSetupController; state: CompanionState }) {
  const pairing = state.pairing;
  if (!pairing) return null;
  const until = new Date(pairing.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-3" data-open-code="">
      <div className="min-w-0 text-[14px] leading-5 text-ink">
        {t("devices.openCode", { until })}
      </div>
      <button type="button" className="settings-quiet cursor-pointer" data-danger="" disabled={c.busy}
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

export function PhoneDevicesSection({ profileEmail = "", focusRequest = 0, simple = false, placeName = t("rail.thisComputer"), top = null }: {
  profileEmail?: string; focusRequest?: number; simple?: boolean; placeName?: string;
  /** what leads the page: the door to pairing with My Cloud, when there is one */
  top?: React.ReactNode;
}) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const pairingFlow = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const loaded = Boolean(state);
  const [pairing, setPairing] = useState<false | "device" | "https">(false);
  const [showRoutes, setShowRoutes] = useState(!simple);
  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(pairingFlow.current)) {
      revealed.current = focusRequest;
      if (takePairOnOpen()) setPairing("device");
    }
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
      <div className="flex flex-col gap-6" ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer">
        {top}
        <SettingsGroup label={t("phone.pair.section")} block="pair">
          <SettingsRows><SettingRow title={t("remote.checking")}><Loader2 size={14} className="animate-spin text-ink-secondary" /></SettingRow></SettingsRows>
        </SettingsGroup>
      </div>
    );
  }

  const pairedCount = state.devices.length;
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const tailscaleStatus = deriveTailscalePairingStatus(state);
  const tailscaleOn = state.routes?.tailscale?.on === true;
  const httpsOn = state.routes?.https?.on === true;
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const anyRoute = companionRoutesOn(state);
  const reachOpen = showRoutes || pairedCount > 0 || anyRoute;
  const moreWays = !simple || tailscaleOn || httpsOn;
  const moreOpen = !simple || tailscaleOn || httpsOn;
  const pairAgain = c.busy || remoteBlocked ? undefined : () => setPairing("device");
  const pairButton = (
    <button type="button" aria-disabled={c.busy || Boolean(remoteBlocked) || undefined} disabled={c.busy} title={managedBy ?? undefined}
      onClick={() => { if (!remoteBlocked) setPairing("device"); }}
      className={cn("ui-button ui-button-primary", remoteBlocked && "opacity-40")} data-pair-device="" data-phone-pairing-action="">
      {t("phone.pair.button")}
    </button>
  );

  return (
    <div className="flex flex-col gap-6 focus:outline-none" ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer">
      {top}
      <RouteNotices c={c} notices={state.notices ?? []} />
      {pairing && <PairDeviceDialog c={c} state={state} placeName={placeName} onClose={() => setPairing(false)} secureAddress={pairing === "https"} />}

      {pairedCount === 0 && !state.pairing ? (
        <SettingsGroup label={t("phone.pair.section")} block="pair">
          <SettingsRows icons>
            <StepRow step={1} title={t("phone.pair.getApp")} subtitle={t("phone.pair.getAppLine")}><StoreButtons /></StepRow>
            <StepRow step={2} title={t("phone.pair.step")} subtitle={t("phone.pair.stepLine", { app: productName() })} reason={remoteBlocked}>{pairButton}</StepRow>
          </SettingsRows>
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup label={t("devices.paired")} block="paired" actions={pairButton}>
            {showTunnelRetiredNotice(c.account, state) && (
              <p role="status" data-devices-notice="tunnel-retired" className="px-4 text-[12px] leading-4 text-warning">{t("remote.devices.retiredShort")}</p>
            )}
            {remoteBlocked && <p role="status" className="px-4 text-[12px] leading-4 text-ink-secondary">{remoteBlocked}</p>}
            {state.pairing && <SettingsRows><OpenCodeRow c={c} state={state} /></SettingsRows>}
            <PairedPhones c={c} state={state} onPairAgain={pairAgain} />
          </SettingsGroup>
          <SettingsGroup label={t("phone.pair.getApp")} block="get-app">
            <SettingsRows><SettingRow title={t("phone.pair.forPhones", { app: productName() })}><StoreButtons /></SettingRow></SettingsRows>
          </SettingsGroup>
        </>
      )}

      {!reachOpen ? (
        <SettingsGroup block="reach" footnote={t("phone.reach.foot")}>
          <SettingsRows>
            <SettingsLinkRow title={t("phone.reach.title")} value={t("devices.route.off")} onClick={() => setShowRoutes(true)} data={{ "data-reach-fold": "" }} />
          </SettingsRows>
        </SettingsGroup>
      ) : (
        <SettingsGroup label={t("phone.reach.title")} block="reach">
          <SettingsRows>
            <RouteRow c={c} state={state} route="wifi" blocked={managedBy} />
            <RouteRow c={c} state={state} route="relay" blocked={managedBy} />
            <SettingRow title={t("remote.keepAwake")} subtitle={t("phone.reach.awakeLine")}
              message={!anyRoute ? t("remote.keepAwakeNeedsRoute") : undefined}>
              <Switch checked={state.keepAwake} aria-label={t("remote.keepAwakeAria")} disabled={c.busy || !anyRoute}
                onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))} />
            </SettingRow>
          </SettingsRows>
          {moreWays && (
            <details className="group mt-4 flex flex-col" open={moreOpen || undefined} data-more-ways="">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu px-4 py-3 text-[14px] leading-5 text-ink hover:bg-menu-hover [&::-webkit-details-marker]:hidden">
                {t("devices.moreWays")}
                <ChevronRight size={14} aria-hidden="true" className="text-ink-tertiary transition-transform group-open:rotate-90" />
              </summary>
              <div className="mt-2 flex flex-col">
                <SettingsRows>
                  <SettingRow title="Tailscale" subtitle={t("remote.tailscaleSwitch.detail", { app: productName() })}
                    message={tailscaleStatus.kind !== "off" ? <span data-tailscale-status={tailscaleStatus.kind} aria-live="polite">{tailscaleStatus.title}{tailscaleStatus.detail ? ` ${tailscaleStatus.detail}` : ""}</span> : undefined}>
                    <span data-route-row="tailscale" className="contents">
                      {tailscaleStatus.kind === "not-installed" && <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="ui-button">{t("remote.tailscale.getIt")}</a>}
                      {tailscaleOn && tailscaleStatus.kind !== "error" && tailscaleStatus.kind !== "not-installed" && (
                        <button type="button" className="settings-quiet cursor-pointer" disabled={c.busy || c.accountBusy} onClick={c.refreshTailscale}>{c.busy ? t("common.checking") : t("remote.checkAgain")}</button>
                      )}
                      <Switch checked={tailscaleOn} aria-label="Tailscale" disabled={c.busy || c.accountBusy || (Boolean(managedBy) && !tailscaleOn)}
                        onClick={() => void c.act((companion) => setCompanionTailscale(companion, !tailscaleOn))} />
                    </span>
                  </SettingRow>
                  <SettingRow title={t("devices.route.https")} subtitle={t("devices.route.httpsDetail", { app: productName() })}
                    message={<>
                      {httpsOn && hosted ? t("devices.route.httpsOn", { address: endpointHost(hosted.url) }) : null}
                      {c.account?.status === "ready" && <span className="block">{t("remote.account.signedIn", { email: c.account.email ?? t("remote.account.yourAccount") })}</span>}
                      {accountActionError && <span className="block text-danger">{accountActionError}</span>}
                    </>}>
                    <span data-route-row="https" className="contents">
                      {httpsOn ? (
                        <button type="button" className="ui-button" disabled={c.busy} onClick={() => void c.act((companion) => setRoute(companion, "https", false))}>{t("devices.route.turnOff")}</button>
                      ) : (
                        <button type="button" className="ui-button" disabled={c.busy || c.accountBusy || Boolean(managedBy)} onClick={() => setPairing("https")}>{t("devices.route.setUp")}</button>
                      )}
                    </span>
                  </SettingRow>
                </SettingsRows>
                {tailscaleOn && state.routes?.tailscale?.name && <div className="mt-4"><TailnetComputers c={c} state={state} blocked={managedBy} simple={simple} /></div>}
              </div>
            </details>
          )}
        </SettingsGroup>
      )}
      <PhonesList />
      {(c.error || state.error) && <div className="px-4 text-[12px] leading-4 text-danger">{c.error ?? state.error}</div>}
    </div>
  );
}

/** A numbered step: the 20 px circle sits in the row's leading slot, so step titles line up with every icon card. */
export function StepRow({ step, title, subtitle, reason, children }: { step: number; title: string; subtitle: string; reason?: string | null; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} data-step-row={step} className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center">
        <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-medium leading-4 text-ink-secondary">{step}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{title}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</span>
          {reason && <span className="text-[12px] leading-4 text-ink-secondary">{reason}</span>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/** Get for iPhone / Get for Android: a code to scan with the phone's camera, to download the app. */
export function StoreButtons() {
  const [open, setOpen] = useState<"ios" | "android" | null>(null);
  const app = PHONE_APPS.find((entry) => entry.id === open);
  return (
    <span className="relative flex items-center gap-2" data-store-buttons="">
      {PHONE_APPS.map((entry) => (
        <button key={entry.id} type="button" className="ui-button" aria-expanded={open === entry.id} data-phone-app={entry.id}
          onClick={() => setOpen((current) => (current === entry.id ? null : entry.id))}>
          {t(entry.id === "ios" ? "phone.pair.getIphone" : "phone.pair.getAndroid")}
        </button>
      ))}
      {app && (
        <span role="dialog" aria-label={t("phone.pair.scanToDownload")} className="popover-surface absolute right-0 top-9 z-30 flex w-[192px] flex-col items-center gap-2 rounded-[12px] p-4 text-center">
          <span className="text-[13px] font-medium leading-[18px] text-ink">{t("phone.pair.scanToDownload")}</span>
          <span className="rounded-md bg-white p-2"><QRCodeSVG value={app.url} size={144} level="M" bgColor="#ffffff" fgColor="#111111" /></span>
          <button type="button" className="cursor-pointer text-[13px] leading-[18px] text-accent-text hover:underline" onClick={() => void openExternalLink(app.url)}>
            {t(app.id === "ios" ? "phone.pair.downloadIphone" : "phone.pair.downloadAndroid")}
          </button>
        </span>
      )}
    </span>
  );
}
