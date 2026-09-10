import { useRef } from "react";
import { t } from "@/lib/i18n";
import {
  Cloud,
  Loader2,
  LogOut,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
} from "lucide-react";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionState,
  type PhoneSetupController,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { ConnectionDetail } from "./ConnectionDetail";
import { Card, Switch } from "./SettingsPrimitives";
import { brand } from "../lib/brand";

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
  kind: "unchecked" | "unavailable" | "magicdns" | "ready" | "error";
  title: string;
  detail: string;
}

export function deriveTailscalePairingStatus(
  state: Pick<CompanionState, "enabled" | "tailscale" | "tailnetName" | "error">,
  routeAvailable: boolean,
): TailscalePairingStatus {
  if (state.error) {
    return {
      kind: "error",
      title: t("remote.status.attention"),
      detail: state.error,
    };
  }
  if (routeAvailable && state.tailnetName) {
    return {
      kind: "ready",
      title: t("remote.tailscale.ready", { name: state.tailnetName }),
      detail: t("remote.tailscale.readyDetail"),
    };
  }
  if (state.tailscale) {
    return {
      kind: "magicdns",
      title: t("remote.tailscale.magicDns"),
      detail: t("remote.tailscale.magicDnsDetail"),
    };
  }
  if (state.enabled) {
    return {
      kind: "unavailable",
      title: t("remote.tailscale.notConnected"),
      detail: t("remote.tailscale.notConnectedDetail"),
    };
  }
  return {
    kind: "unchecked",
    title: t("remote.tailscale.already"),
    detail: t("remote.tailscale.alreadyDetail"),
  };
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
  state: Pick<CompanionState, "enabled" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: t("remote.status.attention"), good: false };
  if (!state.enabled) return { label: t("remote.status.off"), good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: pairedCount === 1
      ? t("remote.devicePairedOne")
      : t("remote.devicesPaired", { count: pairedCount }),
    good: true,
  };
}

const relative = (at: number) => {
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

export function CompanionSection({ profileEmail = "" }: { profileEmail?: string }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const pairingFlow = useRef<HTMLDivElement>(null);

  if (!companionBridge()) {
    return (
      <Card
        title={t("remote.desktopOnly.title", { app: brand().name })}
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
  const tailscaleStatus = deriveTailscalePairingStatus(state, c.tailscaleAvailable);
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
      <div ref={pairingFlow} tabIndex={-1} className="scroll-mt-4 focus:outline-none">
        <Card title={pairingCopy.title} subtitle={pairingCopy.subtitle}>
          {(panelStatus || (pairedCount > 0 && c.hostedReady)) && (
            <div className="mb-4 flex items-center justify-between gap-3">
              {panelStatus && (
                <div
                  className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[11.5px] ${
                    panelStatus.good ? "bg-success/10 text-success" : "bg-control text-ink-secondary"
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${panelStatus.good ? "bg-success" : "bg-ink-secondary/50"}`} />
                  {panelStatus.label}
                </div>
              )}
              {pairedCount > 0 && c.hostedReady && (
                <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                  <ShieldCheck size={13} className="text-accent" /> {t("remote.worksAway")}
                </div>
              )}
            </div>
          )}
          <PhoneSetupFlowView controller={c} variant="settings" />
        </Card>
      </div>

      <Card
        title={t("remote.pairing.tailscale.title")}
        subtitle={t("remote.tailscaleCard.subtitle")}
      >
        <div className="rounded-xl bg-inset px-3 py-3" aria-live="polite">
          <div className="flex items-start gap-2.5">
            <ShieldCheck
              size={16}
              className={`mt-0.5 shrink-0 ${tailscaleStatus.kind === "ready" ? "text-success" : "text-ink-secondary"}`}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">{tailscaleStatus.title}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                {tailscaleStatus.detail}
              </div>
            </div>
          </div>
        </div>
        {tailscaleStatus.kind === "ready" ? (
          <button
            disabled={c.busy || c.accountBusy}
            onClick={() => {
              c.useTailscale();
              window.requestAnimationFrame(() => {
                pairingFlow.current?.scrollIntoView({ block: "start" });
                pairingFlow.current?.focus({ preventScroll: true });
              });
            }}
            className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
          >
            {t("remote.pairOverTailscale")}
          </button>
        ) : (
          <button
            disabled={c.busy || c.accountBusy}
            onClick={c.refreshTailscale}
            className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
          >
            {c.busy ? t("common.checking") : state.enabled ? t("remote.checkAgain") : t("remote.turnOnAndCheck")}
          </button>
        )}
      </Card>

      <Card
        title={t("remote.devices.title")}
        subtitle={
          pairedCount
            ? t("remote.devices.subtitle", { app: brand().name })
            : t("remote.devices.empty")
        }
      >
        {pairedCount > 0 && (
          <ul className="flex flex-col gap-2">
            {state.devices.map((device) => (
              <li key={device.id} className="rounded-xl bg-inset px-3 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                    <Smartphone size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{device.name}</div>
                    <div className="text-[11.5px] text-ink-secondary">{t("remote.devices.lastSeen", { when: relative(device.lastSeenAt) })}</div>
                  </div>
                  <button
                    disabled={c.busy}
                    onClick={() => void c.act((companion) => companion.revoke(device.id))}
                    aria-label={t("remote.devices.remove", { name: device.name })}
                    className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/30 pt-3">
                  <div>
                    <div className="text-[12px] text-ink">{t("remote.devices.allowView")}</div>
                    <div className="mt-0.5 text-[11px] text-ink-secondary">{t("remote.devices.allowViewDetail")}</div>
                  </div>
                  <Switch
                    checked={device.cloudDesktopAccess}
                    aria-label={t("remote.devices.viewAria", { name: device.name })}
                    disabled={c.busy}
                    onClick={() =>
                      void c.act((companion) =>
                        companion.cloudDesktop(device.id, !device.cloudDesktopAccess),
                      )
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <details className="rounded-xl border border-hairline/40 bg-card">
        <summary className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-ink">
          {t("remote.advanced")}
        </summary>
        <div className="flex flex-col gap-4 border-t border-hairline/30 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("remote.title")}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                {t("remote.toggleDetail")}
              </div>
            </div>
            <Switch
              checked={state.enabled}
              aria-label={t("remote.title")}
              disabled={c.busy}
              onClick={() => void c.act((companion) => (state.enabled ? companion.stop() : companion.start()))}
            />
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("remote.keepAwake")}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                {t("remote.keepAwakeDetail")}
              </div>
            </div>
            <Switch
              checked={state.keepAwake}
              aria-label={t("remote.keepAwakeAria")}
              disabled={c.busy || !state.enabled}
              onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
            />
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <Cloud size={15} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">{t("remote.account.title")}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
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
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
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
            <div className="mt-0.5 text-[11.5px] text-ink-secondary">
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
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
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
            <div className="rounded-lg bg-inset px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
              {t("remote.localOnly")}
            </div>
          )}
          {(c.error || state.error) && <div className="text-[12px] text-danger">{c.error ?? state.error}</div>}
        </div>
      </details>
    </div>
  );
}
