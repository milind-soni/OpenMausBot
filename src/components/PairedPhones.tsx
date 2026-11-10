import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

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
  if (e2eEnabled && device.routes === "local") parts.push(t("remote.devices.localOnly"));
  return parts.join(" · ");
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
  return (
    <li className="border-t border-hairline/30 first:border-t-0">
      <div className="flex items-center gap-2.5 px-3 py-3">
        <span className="flex size-3 shrink-0 items-center justify-center" title={phoneSubtitle(device, connected, e2eEnabled)}>
          <span className={`size-2 rounded-full ${live ? "bg-success" : "bg-ink-tertiary/40"}`} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{device.name}</div>
          <div className="truncate text-[12px] text-ink-secondary">{phoneSubtitle(device, connected, e2eEnabled)}</div>
          {c.account?.paused && <div className="truncate text-[12px] text-ink-secondary">{t("remote.devices.paused")}</div>}
          {c.account?.tunnelRetired && !device.e2eAt && (
            <div className="text-[12px] leading-relaxed text-warning" data-phone-retired="">
              {t("remote.devices.retired")}
              {onPairAgain && <>{" "}<button type="button" className="text-accent hover:underline" onClick={onPairAgain}>{t("remote.devices.pairAgain")}</button></>}
            </div>
          )}
        </div>
        <button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={t("remote.devices.more", { name: device.name })}
          className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-hairline/30 px-3 py-3">
          {e2eEnabled && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12px] text-ink">{t("remote.devices.connectFrom")}</div>
              <div role="radiogroup" aria-label={t("remote.devices.connectFrom")} className="flex rounded-lg bg-inset p-0.5 text-[12px]">
                {(["any", "local"] as const).map((routes) => (
                  <button
                    key={routes}
                    role="radio"
                    aria-checked={(device.routes ?? "any") === routes}
                    disabled={c.busy}
                    onClick={() => void c.act((companion) => (companion.routes ? companion.routes(device.id, routes) : companion.state()))}
                    className={`rounded-md px-2.5 py-1 ${(device.routes ?? "any") === routes ? "bg-card text-ink shadow-sm" : "text-ink-secondary"}`}
                  >
                    {routes === "any" ? t("remote.devices.anywhere") : t("remote.devices.localOnly")}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[12px] text-ink">{t("remote.devices.allowView")}</div>
              <div className="mt-0.5 text-[11px] text-ink-secondary">{t("remote.devices.allowViewDetail")}</div>
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
              <div className="text-[12px] text-ink">{t("remote.devices.allowBrowser")}</div>
              <div className="mt-0.5 text-[11px] text-ink-secondary">{t("remote.devices.allowBrowserDetail")}</div>
            </div>
            <Switch
              checked={device.browserControlAccess === true}
              aria-label={t("remote.devices.browserAria", { name: device.name })}
              disabled={c.busy}
              onClick={() => void c.act((companion) => companion.browserControl(device.id, !device.browserControlAccess))}
            />
          </div>
          <button
            disabled={c.busy}
            onClick={() => void c.act((companion) => companion.revoke(device.id)).then(() => onRemoved(device.name))}
            aria-label={t("remote.devices.remove", { name: device.name })}
            className="self-start text-[12px] text-danger hover:underline disabled:opacity-40"
          >
            {t("remote.devices.removePhone")}
          </button>
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
        <ul className="rounded-xl border border-hairline/40 bg-card">
          {sortPhones(state.devices, connected).map((device) => (
            <PhoneRow key={device.id} device={device} connected={connected.has(device.id)} state={state} c={c} onRemoved={setRemoved} onPairAgain={onPairAgain} />
          ))}
        </ul>
      )}
      {removed && (
        <div role="status" className="mt-2 text-[12px] text-ink-secondary">{t("remote.devices.removed", { name: removed })}</div>
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
