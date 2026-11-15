import { useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";

import { t } from "@/lib/i18n";
import type { CompanionState, PhoneDevice, PhoneSetupController } from "./PhoneSetupFlow";
import { SIMPLE_CARD, Switch } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { relative } from "./PhoneDevicesSection";

const ROUTE_LABEL = { wifi: "remote.devices.route.wifi", tailscale: "remote.devices.route.tailscale", relay: "remote.devices.route.relay" } as const;

/** Connected first, then the most recently seen. */
export function sortPhones(devices: PhoneDevice[], connected: ReadonlySet<string>): PhoneDevice[] {
  return [...devices].sort((a, b) => Number(connected.has(b.id)) - Number(connected.has(a.id)) || b.lastSeenAt - a.lastSeenAt);
}

/** One line under the name: the live route, or when it was last seen. An old app connected over plain HTTP says so. */
export function phoneSubtitle(device: PhoneDevice, connected: boolean, e2eEnabled: boolean): string {
  const parts: string[] = [];
  if (device.route) parts.push(t("remote.devices.connected", { route: t(ROUTE_LABEL[device.route]) }));
  else if (connected) parts.push(e2eEnabled && !device.e2eAt ? t("remote.devices.connectedLegacy") : t("remote.devices.connectedNow"));
  else parts.push(t("remote.devices.lastSeen", { when: relative(device.lastSeenAt) }));
  if (e2eEnabled && device.routes === "local") parts.push(t("remote.devices.localOnly"));
  return parts.join(" · ");
}

/** "Same Wi-Fi · ● Connected", "Anywhere · ● Connected", "Last seen 2 hours ago": the route first, then a 6 px dot. */
export function PhoneStatus({ device, connected }: { device: PhoneDevice; connected: boolean }) {
  const route = device.route === "wifi" ? t("devices.route.wifi") : device.route === "relay" ? t("remote.devices.anywhere") : device.route === "tailscale" ? "Tailscale" : null;
  if (!route && !connected) return <>{t("remote.devices.lastSeen", { when: relative(device.lastSeenAt) })}</>;
  return <>{route && <>{route}{" · "}</>}<span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" />{t("remote.devices.connectedNow")}</>;
}

export function PhoneRow({ device, connected, state, c, onRemoved, onPairAgain, defaultOpen = false }: {
  device: PhoneDevice;
  connected: boolean;
  state: CompanionState;
  c: PhoneSetupController;
  onRemoved: (name: string) => void;
  onPairAgain?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const e2eEnabled = state.e2e?.enabled === true;
  const live = connected || Boolean(device.route);
  const retired = c.account?.tunnelRetired && !device.e2eAt;
  return (
    <li data-phone-row={device.id}>
      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary" title={phoneSubtitle(device, connected, e2eEnabled)}>
          <Smartphone size={18} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] leading-5 text-ink">{device.name}</div>
          <div className="truncate text-[13px] leading-[18px] text-ink-secondary" data-phone-status={live ? "connected" : "seen"}>
            <PhoneStatus device={device} connected={live} />
            {e2eEnabled && device.routes === "local" && <>{" · "}{t("remote.devices.localOnly")}</>}
          </div>
          {c.account?.paused && <div className="truncate text-[12px] leading-4 text-ink-secondary">{t("remote.devices.paused")}</div>}
          {retired && (
            <div className="flex items-start gap-1.5 text-[12px] leading-4 text-warning" data-phone-retired="" title={t("remote.devices.retired")}>
              <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warning" />
              <span>{t("remote.devices.retiredShort")}</span>
            </div>
          )}
        </div>
        {retired && onPairAgain ? (
          <button type="button" className="ui-button shrink-0" data-pair-again="" onClick={onPairAgain}>{t("remote.devices.pairAgain")}</button>
        ) : (
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={t("remote.devices.more", { name: device.name })}
            className="ui-button ui-button-md shrink-0 cursor-pointer rounded-full">{t(open ? "common.close" : "remote.devices.options")}</button>
        )}
        <button type="button"
          disabled={c.busy}
          onClick={() => void c.act((companion) => companion.revoke(device.id)).then((next) => { if (next) onRemoved(device.name); })}
          aria-label={t("remote.devices.remove", { name: device.name })}
          data-danger="" data-phone-remove=""
          className="settings-quiet shrink-0 cursor-pointer disabled:opacity-40"
        >
          {t("remote.devices.removeShort")}
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 px-4 pb-3 pl-[60px]">
          {e2eEnabled && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[13px] leading-[18px] text-ink">{t("remote.devices.connectFrom")}</div>
              <div role="radiogroup" aria-label={t("remote.devices.connectFrom")} className="inline-flex h-7 items-center rounded-full bg-ink/[0.05] p-0.5">
                {(["any", "local"] as const).map((routes) => (
                  <button
                    key={routes}
                    role="radio"
                    aria-checked={(device.routes ?? "any") === routes}
                    disabled={c.busy}
                    onClick={() => void c.act((companion) => (companion.routes ? companion.routes(device.id, routes) : companion.state()))}
                    className={`h-6 cursor-pointer rounded-full px-3 text-[13px] leading-5 ${(device.routes ?? "any") === routes ? "bg-menu font-medium text-ink shadow-[inset_0_0_0_0.5px_var(--settings-edge)]" : "text-ink-secondary"}`}
                  >
                    {routes === "any" ? t("remote.devices.anywhere") : t("remote.devices.localOnly")}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] leading-[18px] text-ink">{t("remote.devices.allowView")}</div>
              <div className="text-[12px] leading-4 text-ink-secondary">{t("remote.devices.allowViewDetail")}</div>
            </div>
            <Switch
              checked={device.cloudDesktopAccess}
              aria-label={t("remote.devices.viewAria", { name: device.name })}
              disabled={c.busy}
              onClick={() => void c.act((companion) => companion.cloudDesktop(device.id, !device.cloudDesktopAccess))}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] leading-[18px] text-ink">{t("remote.devices.allowBrowser")}</div>
              <div className="text-[12px] leading-4 text-ink-secondary">{t("remote.devices.allowBrowserDetail")}</div>
            </div>
            <Switch
              checked={device.browserControlAccess === true}
              aria-label={t("remote.devices.browserAria", { name: device.name })}
              disabled={c.busy}
              onClick={() => void c.act((companion) => companion.browserControl(device.id, !device.browserControlAccess))}
            />
          </div>
        </div>
      )}
    </li>
  );
}

/** One grouped card: a dot, the name and one line per phone. Remove acts at once. */
export function PairedPhones({ c, state, onPairAgain }: { c: PhoneSetupController; state: CompanionState; onPairAgain?: () => void }) {
  const [removed, setRemoved] = useState<string | null>(null);
  const connected = new Set(state.connectedDeviceIds ?? []);
  if (state.devices.length === 0 && !removed) return null;
  return (
    <>
      {state.devices.length > 0 && (
        <ul data-settings-rows="" data-settings-icons="" className={cn(SIMPLE_CARD, "flex flex-col overflow-hidden")}>
          {sortPhones(state.devices, connected).map((device) => (
            <PhoneRow key={device.id} device={device} connected={connected.has(device.id)} state={state} c={c} onRemoved={setRemoved} onPairAgain={onPairAgain} />
          ))}
        </ul>
      )}
      {removed && (
        <div role="status" className="px-4 text-[12px] leading-4 text-ink-secondary">{t("remote.devices.removed", { name: removed })}</div>
      )}
    </>
  );
}

/** "Connecting…" appears only once it has lasted this long, so a quick reconnect shows nothing. */
export const CONNECTING_DELAY_MS = 1_500;
/** A line, once shown, stays at least this long, so it never flickers. */
export const MIN_VISIBLE_MS = 400;

/** When `wanted` (wanted since `since`) may replace what is on screen. */
export function steadyAt(shown: { text: string | null; at: number }, since: number, connecting: boolean): number {
  return Math.max(connecting ? since + CONNECTING_DELAY_MS : since, shown.text === null ? 0 : shown.at + MIN_VISIBLE_MS);
}

/** The relay line with PAIRING-UX's timing; until anything shows, the section's own description. */
export function RelayLine({ state, fallback }: { state: Pick<CompanionState, "enabled" | "e2e">; fallback: string }) {
  const wanted = relayStatusLine(state);
  const connecting = state.enabled && state.e2e?.enabled === true && state.e2e.relay === "connecting";
  const since = useRef({ text: wanted, at: Date.now() });
  if (since.current.text !== wanted) since.current = { text: wanted, at: Date.now() };
  const [shown, setShown] = useState<{ text: string | null; at: number }>(() => ({ text: connecting ? null : wanted, at: Date.now() }));
  useEffect(() => {
    if (shown.text === wanted) return;
    const wait = steadyAt(shown, since.current.at, connecting) - Date.now();
    const timer = setTimeout(() => setShown({ text: wanted, at: Date.now() }), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [wanted, connecting, shown]);
  return <>{shown.text ?? fallback}</>;
}

/** The line under Remote access: where phones can reach this computer from, once it is end-to-end encrypted. */
export function relayStatusLine(state: Pick<CompanionState, "enabled" | "e2e">): string | null {
  if (!state.enabled || state.e2e?.enabled !== true) return null;
  if (state.e2e.relay === "connected") return t("remote.e2e.anywhere");
  if (state.e2e.relay === "connecting") return t("remote.e2e.connecting");
  return t("remote.e2e.local");
}
