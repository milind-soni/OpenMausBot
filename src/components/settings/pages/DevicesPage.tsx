import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Laptop } from "lucide-react";
import { copyText } from "@/lib/copy-text";
import { privateNetwork, type Device, type DeviceAction, type PrivateNetwork } from "@/lib/devices";
import { t } from "@/lib/i18n";
import { phoneRemovePath } from "@/lib/phones";
import { useDevices } from "@/lib/use-devices";
import type { CompanionState } from "@/lib/companion-types";
import { api } from "@/state/api";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { AddDeviceDialog, type AddKind } from "../../devices/AddDeviceDialog";
import { DeviceMap, type NetworkAction } from "../../devices/DeviceMap";
import { DevicePanel } from "../../devices/DevicePanel";
import { networkLine } from "../../devices/device-words";
import { PairDeviceDialog } from "../../PhoneDevicesSection";
import { usePhoneSetupController } from "../../PhoneSetupFlow";
import { OwnServerLink, RailSheet } from "../../PlaceAddSheet";
import { updateCommand } from "../../ServerList";
import { PlaceBadge } from "../SettingsNav";
import { useSettingsShell } from "../settings-shell";

type Sheet = { address: string; locked: boolean; title: string } | null;

/** Tailscale's download page for this computer's system. */
export function tailscaleDownload(platform: string | undefined): string {
  if (platform === "darwin") return "https://tailscale.com/download/mac";
  if (platform === "win32") return "https://tailscale.com/download/windows";
  if (platform === "linux") return "https://tailscale.com/download/linux";
  return "https://tailscale.com/download";
}

/** The private network's one next step, for the map and the Add flow. Null while an organization turned remote access off. */
export function nextNetworkStep(network: PrivateNetwork | null, run: { check: () => void; addComputer: () => void }, opts: { busy: boolean; blocked: boolean; platform?: string }): NetworkAction | null {
  if (!network || opts.blocked) return null;
  switch (network.state) {
    case "unknown": return { label: t("devicesPage.network.setUp"), run: run.check, busy: opts.busy };
    case "not-installed": return { label: t("remote.tailscale.getIt"), href: tailscaleDownload(opts.platform) };
    case "ready": return network.shared ? { label: t("devicesPage.network.addComputer"), run: run.addComputer } : { label: t("devicesPage.network.share"), run: run.check, busy: opts.busy };
    default: return { label: t("remote.checkAgain"), run: run.check, busy: opts.busy };
  }
}

/** A recheck when the person comes back to the window: at most this often, and only after they asked once here. */
const RECHECK_MS = 5_000;

export function DevicesPage() {
  const { ctx, place, go } = useSettingsShell();
  const dispatch = useStoreDispatch();
  const config = useStoreSelector((state) => state.config);
  const { devices, companion, refresh } = useDevices({ here: ctx.here, client: ctx.client, name: place.name, kind: place.kind });
  const c = usePhoneSetupController(config?.profile?.email);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<AddKind | null | false>(false);
  const [pairingPhone, setPairingPhone] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [problem, setProblem] = useState<CompanionState["tailscaleProblem"] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const asked = useRef(0);
  const blocked = config?.managedPolicy?.remoteAccess === false ? t("policy.managedBy", { organization: config.managedPolicy.organizationName }) : null;
  const network = ctx.here ? privateNetwork(companion, problem) : null;

  // The Tailscale checks Phone & devices already has, on a click only, never on load or in a poll: with its route off,
  // Your other computers' switch (it checks, then lets this computer's other computers open it); with it on, Check
  // again, which asks Tailscale again; ready but not shared, the switch alone.
  const check = useCallback(async () => {
    asked.current = Date.now();
    const route = companion?.routes?.tailscale;
    const ask = route?.on && (!route.name || route.computers || problem) ? "refresh" : "share";
    const next = await c.act((bridge) => (ask === "refresh" ? bridge.refreshTailscale() : bridge.setTailscaleComputers?.(true) ?? bridge.refreshTailscale()));
    if (next) setProblem(next.tailscaleProblem ?? null);
    refresh();
  }, [c, refresh, companion, problem]);

  useEffect(() => {
    if (!problem) return;
    const onFocus = () => { if (asked.current && Date.now() - asked.current > RECHECK_MS) void check(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [problem, check]);

  const networkAction = nextNetworkStep(network, { check: () => void check(), addComputer: () => setAdding("computer") },
    { busy: c.busy, blocked: Boolean(blocked), platform: window.ogb?.platform });

  const environments = ctx.here ? window.ogb?.environments : undefined;
  const places = useMemo(() => devices.filter((device) => device.sources[0]?.type === "place").map((device) => ({ id: device.sources[0]!.id, name: device.name })), [devices]);

  const act = async (device: Device, action: DeviceAction) => {
    setFailure(null);
    try {
      switch (action.type) {
        case "switch": await environments?.switch(action.placeId); return;
        case "retry": await environments?.retry?.(action.placeId); break;
        case "pair-again": setSheet({ address: action.address, locked: true, title: t("servers.pairAgainTitle", { name: device.name }) }); return;
        case "copy-address": await copyText(action.address); return;
        case "copy-update": await copyText(updateCommand(action.install, window.ogb?.app?.version ?? "")); return;
        case "manage": go(action.page, action.anchor); return;
        case "remove": {
          const { source } = action;
          if (source.type === "place") await environments?.forget(source.id);
          else if (source.type === "phone") await c.act((bridge) => bridge.revoke(source.id));
          else if (source.type === "phone-app") await api(phoneRemovePath(source.id), { method: "DELETE" });
          else if (source.type === "session") await api(`/api/auth/sessions/${encodeURIComponent(source.id)}`, { method: "DELETE" });
          if (selected === device.id) setSelected(null);
          break;
        }
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
    refresh();
  };

  const mark = place.kind === "computer" ? <Laptop size={20} aria-hidden="true" /> : <PlaceBadge place={place} size={24} />;
  const workspaces = ctx.here ? window.ogb?.workspaces : undefined;
  const chosen = selected ? devices.find((device) => device.id === selected) : undefined;
  const close = () => {
    const id = selected;
    setSelected(null);
    if (id) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-device-node="${CSS.escape(id)}"]`)?.focus());
  };
  const shared = network?.state === "ready" && network.shared;
  const secondary = network && (networkAction?.href
    ? <button type="button" className="settings-quiet cursor-pointer" disabled={c.busy} onClick={() => void check()}>{c.busy ? t("common.checking") : t("remote.checkAgain")}</button>
    : shared ? <button type="button" className="settings-quiet cursor-pointer" onClick={() => go("phone", "computers")}>{t("devicesPage.action.manage")}</button> : null);

  return <>
    <DeviceMap devices={devices} mark={mark} selected={chosen ? chosen.id : null} onSelect={(id) => { setNotice(null); setSelected((now) => (now === id ? null : id)); }} onClose={close}
      onAction={(device, action) => void act(device, action)} onAdd={() => setAdding(null)}
      network={network && { network, line: blocked ?? networkLine(network), action: networkAction, secondary }}
      panel={(caret) => chosen && <DevicePanel device={chosen} caret={caret} onAction={(device, action) => void act(device, action)} onClose={close}
        onRemoved={(text) => { setSelected(null); setNotice(text); refresh(); }} />} />
    {failure && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{failure}</p>}
    {notice && <p role="status" className="px-4 text-[12px] leading-4 text-ink-secondary">{notice}</p>}
    {adding !== false && (
      <AddDeviceDialog here={ctx.here} cloud={ctx.cloud} network={network} networkAction={networkAction} tailnetAddress={companion?.tailnetShare?.origin ?? null} places={places} start={adding}
        onClose={() => { setAdding(false); refresh(); }} onConnected={refresh}
        onPairPhone={ctx.here ? () => { setAdding(false); setPairingPhone(true); } : null} onCheck={() => void check()} checking={c.busy}
        onConnectServer={workspaces?.add ? () => setSheet({ address: "", locked: false, title: t("connect.title") }) : null}
        onGetCloud={workspaces?.add ? () => { setAdding(false); dispatch({ type: "toggleAppSettings", open: false }); void workspaces.add?.("cloud"); } : null} />
    )}
    {pairingPhone && c.state && <PairDeviceDialog c={c} state={c.state} placeName={place.name} onClose={() => { setPairingPhone(false); refresh(); }} />}
    {sheet && (
      <RailSheet focusKey={sheet.locked ? "pair-again" : "connect"} onClose={() => setSheet(null)}>
        <OwnServerLink onBack={null} onConnected={() => { setSheet(null); refresh(); }} start={sheet.address || sheet.locked ? sheet : null} />
      </RailSheet>
    )}
  </>;
}
