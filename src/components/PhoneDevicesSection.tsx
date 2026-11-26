import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { CompanionAccountState } from "../types/ogb";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionBridge,
  type CompanionRoute,
  type CompanionState,
  type PhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { showTunnelRetiredNotice } from "../lib/phone-link";
import { RemoteAccessCheckRow } from "./RemoteAccessCheck";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows, Switch } from "./SettingsPrimitives";
import { DialogTitle } from "./settings/SettingsDialog";
export { DialogTitle };
import { productName } from "../lib/brand";

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
  if (state.tailscaleProblem === "needs-approval") return { kind: "signed-out", title: t("remote.tailscale.needsApproval"), detail: "" };
  if (state.tailscaleProblem === "signed-out") return { kind: "signed-out", title: t("remote.tailscale.signIn"), detail: "" };
  if (state.tailscaleProblem === "custom-name") return { kind: "magicdns", title: t("remote.tailscale.customName"), detail: t("remote.tailscale.customNameDetail") };
  if (state.tailscaleProblem === "magicdns") return { kind: "magicdns", title: t("remote.tailscale.magicDns"), detail: t("remote.tailscale.magicDnsDetail") };
  if (state.error) return { kind: "error", title: t("remote.status.attention"), detail: state.error };
  const route = state.routes?.tailscale;
  if (!route?.on) return { kind: "off", title: t("remote.status.off"), detail: "" };
  if (!route.name) return { kind: "magicdns", title: t("remote.tailscale.magicDns"), detail: t("remote.tailscale.magicDnsDetail") };
  const title = t("remote.tailscale.ready", { name: route.name });
  return state.enabled
    ? { kind: "ready", title, detail: t("remote.tailscale.readyDetail") }
    : { kind: "waiting", title, detail: t("remote.tailscale.linkOff") };
}

/** The control plane gives a build with the encrypted connection no free web address (`relay_capable`): there the row
 * shows only while the route is on or the account still holds an address. `renewPairing` is what such a build's bridge adds. */
export function showHttpsAddressRow(state: Pick<CompanionState, "routes">, account: Pick<CompanionAccountState, "endpoint"> | null, bridge: Pick<CompanionBridge, "renewPairing"> | null): boolean {
  return state.routes?.https?.on === true || Boolean(account?.endpoint) || typeof bridge?.renewPairing !== "function";
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

export function setRoute(companion: CompanionBridge, route: CompanionRoute, on: boolean): Promise<CompanionState> {
  if (route === "tailscale") return setCompanionTailscale(companion, on);
  return companion.setRoute?.(route, on) ?? (on ? companion.start([route]) : companion.state());
}

const ROUTE_LINE = { wifi: "phone.reach.wifiLine", relay: "phone.reach.anywhereLine" } as const;

function RouteRow({ c, state, route, blocked, onSignIn }: { c: PhoneSetupController; state: CompanionState; route: "wifi" | "relay"; blocked: string | null; onSignIn?: () => void }) {
  const current = state.routes?.[route];
  // Anywhere needs a free MausBot sign-in: signed out, it stays in place, inert, with the way to sign in under it.
  const needsSignIn = route === "relay" && c.account?.available !== false && c.account?.status !== "ready";
  if (needsSignIn && !current?.on && !blocked) {
    return (
      <SettingRow title={t(ROUTE_TEXT[route].name, { app: productName() })} subtitle={t(ROUTE_LINE[route])} inertText={t("phone.pair.needsSignInLine", { app: productName() })}
        inert={<>{t("phone.pair.needsSignInLine", { app: productName() })}{onSignIn && <>{" "}<button type="button" className="pointer-events-auto cursor-pointer text-accent-text hover:underline" data-relay-sign-in="" onClick={onSignIn}>{t("phone.pair.signIn")}</button></>}</>}>
        <span data-route-row={route} className="contents"><Switch checked={false} aria-label={t(ROUTE_TEXT[route].name, { app: productName() })} tabIndex={-1} /></span>
      </SettingRow>
    );
  }
  const inert = Boolean(blocked) && !current?.on;
  return (
    <SettingRow title={t(ROUTE_TEXT[route].name, { app: productName() })} subtitle={t(ROUTE_LINE[route])}
      message={current?.on && state.devices.length === 0 ? routeStateText(current, 0) : inert ? blocked : undefined}>
      <span data-route-row={route} className="contents">
        <Switch checked={current?.on === true} aria-label={t(ROUTE_TEXT[route].name, { app: productName() })} disabled={c.busy || inert} title={blocked ?? undefined}
          onClick={() => void c.act((companion) => setRoute(companion, route, !current?.on))} />
      </span>
    </SettingRow>
  );
}

export type PairStep = "consent" | "sign-in" | "pairing";
type PairRoute = "wifi" | "relay";
const PAIR_ROUTES: readonly PairRoute[] = ["wifi", "relay"];

/** A short line keeps compound words such as "End-to-end" whole: its hyphens never break a line. */
const keepWhole = (text: string) => text.replace(/(\p{L})-(?=\p{L})/gu, "$1\u2011");

/** One way in to pick, as a checkbox row: the name, a line, and what it still needs. Rows after the first part with a hairline. */
function RouteCard({ route, chosen, disabled, onChoose, needs, action, hint }: {
  route: PairRoute; chosen: boolean; disabled?: boolean; onChoose: (on: boolean) => void; needs?: ReactNode;
  /** under the needs line, at the text's edge: Sign in */
  action?: ReactNode;
  /** a note for this way only, under its line (the local network permission) */
  hint?: ReactNode;
}) {
  return (
    <div data-route-card={route} data-chosen={chosen ? "" : undefined}
      className="flex flex-col gap-1 py-3 [&+&]:shadow-[inset_0_0.5px_0_var(--settings-edge)]">
      <label className={cn("flex items-start gap-3", disabled ? "cursor-default" : "cursor-pointer")}>
        <input type="checkbox" name="pair-route" value={route} checked={chosen} disabled={disabled} onChange={(event) => onChoose(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-ink)] disabled:opacity-40" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("text-[14px] leading-5", disabled ? "text-ink-secondary" : "text-ink")}>{t(ROUTE_TEXT[route].name, { app: productName() })}</span>
          {/* One measure for the card's text: the line wraps like the hint under it (no early "pretty" wrap). */}
          <span className="text-[13px] leading-[18px] text-ink-secondary [text-wrap-style:auto]">{keepWhole(t(ROUTE_LINE[route]))}</span>
          {needs && <span className="text-[12px] leading-4 text-ink-secondary">{needs}</span>}
          {hint && <span className="mt-1 text-[12px] leading-4 text-ink-secondary">{hint}</span>}
        </span>
      </label>
      {action && <div className="pl-7">{action}</div>}
    </div>
  );
}

/** Where Add a phone starts: at the code when a way in is already on (or the HTTPS address was asked for), else at the choice. */
export const firstPairStep = (state: CompanionState, secureAddress: boolean): PairStep =>
  (["wifi", "relay"] as const).some((route) => state.routes?.[route]?.on) || state.routes?.tailscale?.on === true || secureAddress ? "pairing" : "consent";

/** What a control outside the steps asked them to start with: the free web address (HTTPS Set up) or the sign-in Anywhere needs. */
export type PairAsk = "https" | "sign-in" | null;

/**
 * Add a phone's steps on This computer: which way the phone reaches it comes first, then the code (`codeView`, in the
 * page's own look). The page's Back is the way out; a code still open is cancelled when the steps go away.
 */
export function PairPhoneSteps({ c, state, ask = null, codeView }: { c: PhoneSetupController; state: CompanionState; ask?: PairAsk; codeView: ReactNode }) {
  const signedIn = c.account?.status === "ready";
  const relayAvailable = c.account?.available !== false;
  const [picked, setPicked] = useState<ReadonlySet<PairRoute>>(() => new Set([signedIn && relayAvailable ? "relay" : "wifi"]));
  const pick = (route: PairRoute, on: boolean) => setPicked((now) => {
    const next = new Set(now);
    if (on) next.add(route); else next.delete(route);
    return next;
  });
  const ways = PAIR_ROUTES.filter((route) => picked.has(route) && (route !== "relay" || (signedIn && relayAvailable)));
  const [step, setStep] = useState<PairStep>(() => (ask === "sign-in" && !signedIn ? "sign-in" : firstPairStep(state, ask === "https")));
  const { start } = c;
  const startAsked = useRef(ask === "https" || (ask === "sign-in" && !signedIn));
  useEffect(() => {
    if (!startAsked.current) return;
    startAsked.current = false;
    start();
  }, [start]);
  // Back from the sign-in: with it, Anywhere is chosen; cancelled, the same screen as before.
  const signingIn = useRef(false);
  useEffect(() => {
    if (step !== "sign-in") return;
    if (signedIn) { setPicked((now) => new Set([...now, "relay"])); setStep("consent"); return; }
    if (c.phase === "sign-in") signingIn.current = true;
    else if (signingIn.current) { signingIn.current = false; setStep("consent"); }
  }, [step, signedIn, c.phase]);
  const opened = useRef(false);
  opened.current = step !== "consent";
  const cancel = useRef(c.cancel);
  cancel.current = c.cancel;
  // Checked a tick later: a development remount is not a close.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.setTimeout(() => { if (!mounted.current && opened.current) cancel.current(); }, 0); };
  }, []);
  const begin = async () => {
    for (const route of ways) if (!await c.act((bridge) => setRoute(bridge, route, true))) return;
    setStep("pairing");
    c.useLocal();
  };
  const localHint = picked.has("wifi") && !state.routes?.wifi?.on && typeof window !== "undefined" && window.ogb?.platform === "darwin";
  if (step === "sign-in") return <PhoneSetupFlowView controller={c} />;
  if (step === "pairing") return <>{codeView}</>;
  return <>
    <p className="text-[13px] leading-[18px] text-ink-secondary">{t("phone.pair.howReach")}</p>
    <div role="group" aria-label={t("phone.pair.howReach")} className="-my-3 flex flex-col">
      <RouteCard route="wifi" chosen={picked.has("wifi")} onChoose={(on) => pick("wifi", on)}
        hint={localHint ? <span data-local-network-hint="">{t("phone.pair.localNetworkHint", { app: productName() })}</span> : undefined} />
      {relayAvailable && (
        <RouteCard route="relay" chosen={signedIn && picked.has("relay")} disabled={!signedIn} onChoose={(on) => pick("relay", on)}
          needs={signedIn ? undefined : t("phone.pair.needsSignIn", { app: productName() })}
          action={!signedIn && (
            <button type="button" className="ui-button ui-button-md mt-1 rounded-full" data-pair-sign-in=""
              onClick={() => { setStep("sign-in"); c.start(); }}>{t("phone.pair.signIn")}</button>
          )} />
      )}
    </div>
    <p className="text-[12px] leading-4 text-ink-secondary">{t("phone.pair.footHere")}</p>
    {c.error && <p role="alert" className="text-[12px] leading-4 text-danger">{c.error}</p>}
    <div className="flex gap-2">
      <button type="button" disabled={c.busy || ways.length === 0} onClick={() => void begin()} className="ui-button ui-button-primary" data-pair-turn-on="">{t("phone.pair.turnOnShow")}</button>
    </div>
  </>;
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

/** "Reaches this computer on the same Wi-Fi and anywhere through MausBot." */
export function reachLine(state: Pick<CompanionState, "routes">): string {
  const on = (route: CompanionRoute) => state.routes?.[route]?.on === true;
  const ways = [
    on("wifi") && t("devices.reach.sameWifi"),
    on("tailscale") && t("devices.reach.privateNetwork"),
    on("https") && t("devices.reach.https", { app: productName() }),
    on("relay") && t("devices.reach.relay", { app: productName() }),
  ].filter((way): way is string => Boolean(way));
  if (ways.length === 0) return t("devices.reach.none");
  return t("devices.reach.line", { ways: new Intl.ListFormat(undefined, { type: "conjunction" }).format(ways) });
}

/** How a phone reaches this computer: nothing paired and no way on reads as one closed row. The private network is the
 * row in "You're here"; the HTTPS address shows in Advanced or once it is on. Sign in and HTTPS Set up open Add a
 * phone's steps at what they asked for. */
export function ReachSection({ c, state, simple, moreWaysAsked, managedBy, onPair }: {
  c: PhoneSetupController; state: CompanionState; simple: boolean; managedBy: string | null; onPair: (ask: PairAsk) => void;
  /** search or a link asked for the HTTPS address, which Simple leaves out until it is on */
  moreWaysAsked: boolean;
}) {
  const [showRoutes, setShowRoutes] = useState(false);
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const httpsOn = state.routes?.https?.on === true;
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const anyRoute = companionRoutesOn(state);
  const httpsPeek = simple && moreWaysAsked && !httpsOn;
  const httpsShown = (!simple || httpsOn || httpsPeek) && showHttpsAddressRow(state, c.account, companionBridge());
  if (!(showRoutes || state.devices.length > 0 || anyRoute || moreWaysAsked)) {
    return (
      <SettingsGroup label={t("phone.reach.title")} block="reach">
        <SettingsRows>
          <SettingsLinkRow title={t("phone.reach.offAdding")} onClick={() => setShowRoutes(true)} data={{ "data-reach-fold": "" }} />
        </SettingsRows>
        <span data-settings-block="more-ways" className="contents" />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup label={t("phone.reach.title")} block="reach">
      <SettingsRows>
        <RouteRow c={c} state={state} route="wifi" blocked={managedBy} />
        <RouteRow c={c} state={state} route="relay" blocked={managedBy} onSignIn={() => onPair("sign-in")} />
        <SettingRow title={t("remote.keepAwake")} subtitle={t("phone.reach.awakeLine")} inert={!anyRoute ? t("remote.keepAwakeNeedsRoute") : undefined}>
          <Switch checked={state.keepAwake} aria-label={t("remote.keepAwakeAria")} disabled={c.busy || !anyRoute}
            onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))} />
        </SettingRow>
        <RemoteAccessCheckRow account={c.account} state={state} />
        <div data-settings-block="more-ways" className="contents">
          {httpsShown && <SettingRow title={t("devices.route.https")} tag={httpsPeek ? t("settings.advancedSetting") : undefined} subtitle={t("devices.route.httpsDetail", { app: productName() })}
            message={(httpsOn && hosted) || c.account?.status === "ready" || accountActionError ? <>
              {httpsOn && hosted ? t("devices.route.httpsOn", { address: endpointHost(hosted.url) }) : null}
              {c.account?.status === "ready" && <span className="block">{t("devices.route.httpsAccount", { app: productName() })}</span>}
              {accountActionError && <span className="block text-danger">{accountActionError}</span>}
            </> : undefined}>
            <span data-route-row="https" className="contents">
              {httpsOn ? (
                <button type="button" className="ui-button" disabled={c.busy} onClick={() => void c.act((companion) => setRoute(companion, "https", false))}>{t("devices.route.turnOff")}</button>
              ) : (
                <button type="button" className="ui-button" disabled={c.busy || c.accountBusy || Boolean(managedBy)} onClick={() => onPair("https")}>{t("devices.route.setUp")}</button>
              )}
            </span>
          </SettingRow>}
        </div>
      </SettingsRows>
    </SettingsGroup>
  );
}

/** Your phone: one row in an untitled plain card. Where to get the phone app is said in plain words, with no link: the
 * desktop app never opens a store or a download. The code itself, and "scan this code", appear only in the dialog. */
export function PairRow({ reason, children }: { reason?: string | null; children: React.ReactNode }) {
  return (
    <SettingRow title={t("phone.pair.rowTitle")} subtitle={t("phone.pair.rowLine", { app: productName() })} message={reason ?? undefined}>
      {children}
    </SettingRow>
  );
}

/** A numbered step: the 20 px circle sits in the row's leading slot, so step titles line up with every icon card. */
export function StepRow({ step, title, subtitle, reason, children }: { step: number; title: string; subtitle: React.ReactNode; reason?: string | null; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} data-step-row={step} className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center self-center @max-[480px]/rows:-mt-1.5 @max-[480px]/rows:self-start">
        <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-medium leading-4 text-ink-secondary">{step}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-[min(100%,7rem)] flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{title}</span>
          <span className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</span>
          {reason && <span className="text-[12px] leading-4 text-ink-secondary">{reason}</span>}
        </div>
        {children != null && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
