import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import type { CompanionState, PhoneDevice, PhoneSetupController } from "./PhoneSetupFlow";
import { Switch } from "./SettingsPrimitives";
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
  if (e2eEnabled && device.routes === "local") parts.push(t("remote.devices.homeOrPrivate"));
  return parts.join(" · ");
}

/** "Same Wi-Fi · ● Connected", "Anywhere · ● Connected", "Last seen 2 hours ago": the route first, then a 6 px dot. */
export function PhoneStatus({ device, connected }: { device: PhoneDevice; connected: boolean }) {
  const route = device.route === "wifi" ? t("devices.route.wifi") : device.route === "relay" ? t("remote.devices.anywhere") : device.route === "tailscale" ? "Tailscale" : null;
  if (!route && !connected) return <>{t("remote.devices.lastSeen", { when: relative(device.lastSeenAt) })}</>;
  return <>{route && <>{route}{" · "}</>}<span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" />{t("remote.devices.connectedNow")}</>;
}

/** A paired phone's own controls, in its details: where it may connect from, cloud desktops and the browser, and Pair
 * again for one with an older app. */
export function PhoneControls({ device, c, onPairAgain, onChanged }: { device: PhoneDevice; c: PhoneSetupController; onPairAgain?: () => void; onChanged?: () => void }) {
  const act = (ask: Parameters<PhoneSetupController["act"]>[0]) => void c.act(ask).then(() => onChanged?.());
  const e2eEnabled = c.state?.e2e?.enabled === true;
  const retired = c.account?.tunnelRetired && !device.e2eAt;
  return (
    <div data-phone-controls={device.id} className="flex flex-col gap-3">
      {c.account?.paused && <p className="text-[12px] leading-4 text-ink-secondary">{t("remote.devices.paused")}</p>}
      {retired && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-[12px] leading-4 text-warning" data-phone-retired="" title={t("remote.devices.retired")}>
            <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-warning" />
            <span>{t("remote.devices.retiredShort")}</span>
          </p>
          {onPairAgain && <button type="button" className="ui-button shrink-0" data-pair-again="" onClick={onPairAgain}>{t("remote.devices.pairAgain")}</button>}
        </div>
      )}
      {e2eEnabled && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-[14px] leading-5 text-ink">{t("remote.devices.connectFrom")}</div>
          <div role="radiogroup" aria-label={t("remote.devices.connectFrom")} className="inline-flex h-7 items-center rounded-full bg-ink/[0.05] p-0.5">
            {(["any", "local"] as const).map((routes) => (
              <button
                key={routes}
                type="button"
                role="radio"
                aria-checked={(device.routes ?? "any") === routes}
                disabled={c.busy}
                data-phone-routes={routes}
                onClick={() => act((companion) => (companion.routes ? companion.routes(device.id, routes) : companion.state()))}
                className={`h-6 cursor-pointer rounded-full px-3 text-[13px] leading-5 ${(device.routes ?? "any") === routes ? "bg-menu font-medium text-ink shadow-[inset_0_0_0_0.5px_var(--settings-edge)]" : "text-ink-secondary"}`}
              >
                {routes === "any" ? t("remote.devices.anywhere") : t("remote.devices.homeOrPrivate")}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[14px] leading-5 text-ink">{t("remote.devices.desktopsTitle")}</div>
          <div className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{t("remote.devices.desktopsLine")}</div>
        </div>
        <Switch
          checked={device.cloudDesktopAccess}
          aria-label={t("remote.devices.desktopsAria", { name: device.name })}
          disabled={c.busy}
          data-phone-cloud-desktop=""
          onClick={() => act((companion) => companion.cloudDesktop(device.id, !device.cloudDesktopAccess))}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[14px] leading-5 text-ink">{t("remote.devices.browserTitle")}</div>
          <div className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{t("remote.devices.browserLine")}</div>
        </div>
        <Switch
          checked={device.browserControlAccess === true}
          aria-label={t("remote.devices.browserUseAria", { name: device.name })}
          disabled={c.busy}
          data-phone-browser=""
          onClick={() => act((companion) => companion.browserControl(device.id, !device.browserControlAccess))}
        />
      </div>
    </div>
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
