import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop } from "lucide-react";
import { privateNetwork, groupByKind, type Device, type DeviceAction, type DeviceGroup, type PrivateNetwork } from "@/lib/devices";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { phoneRemovePath } from "@/lib/phones";
import { useDevices } from "@/lib/use-devices";
import type { CompanionState } from "@/lib/companion-types";
import { api } from "@/state/api";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { AddDevicePanel, type AddKind } from "../../devices/AddDevicePanel";
import { GroupSection, HereSection, type NetworkAction, type Opened } from "../../devices/DeviceRows";
import { PhoneCodeInline } from "../../devices/CodeCard";
import { networkLine } from "../../devices/device-words";
import { PairPhoneSteps } from "../../PhoneDevicesSection";
import { usePhoneSetupController } from "../../PhoneSetupFlow";
import { SettingsMark } from "../../SettingsPrimitives";
import { PlaceBadge } from "../SettingsNav";
import { useSettingsShell } from "../settings-shell";

/** Tailscale's download page for this computer's system. */
export function tailscaleDownload(platform: string | undefined): string {
  if (platform === "darwin") return "https://tailscale.com/download/mac";
  if (platform === "win32") return "https://tailscale.com/download/windows";
  if (platform === "linux") return "https://tailscale.com/download/linux";
  return "https://tailscale.com/download";
}

/** The private network's one next step, for its row and the Add flow. Null while an organization turned remote access off. */
export function nextNetworkStep(network: PrivateNetwork | null, run: { check: () => void; addComputer: () => void }, opts: { busy: boolean; blocked: boolean; platform?: string }): NetworkAction | null {
  if (!network || opts.blocked) return null;
  switch (network.state) {
    case "unknown": return { label: t("devicesPage.network.setUp"), run: run.check, busy: opts.busy };
    case "not-installed": return { label: t("remote.tailscale.getIt"), href: tailscaleDownload(opts.platform) };
    case "ready": return network.shared ? { label: t("devicesPage.network.addComputer"), run: run.addComputer } : { label: t("devicesPage.network.allow"), run: run.check, busy: opts.busy };
    default: return { label: t("remote.checkAgain"), run: run.check, busy: opts.busy };
  }
}

/** Where a computer waiting for approval on the private network is approved. */
const TAILSCALE_ADMIN = "https://login.tailscale.com/admin/machines";

/** A recheck when the person comes back to the window: at most this often, and only after they asked once here. */
const RECHECK_MS = 5_000;

const ADD_LABEL: Record<DeviceGroup, Parameters<typeof t>[0]> = { phones: "devicesPage.addGroup.phone", computers: "devicesPage.addGroup.computer", servers: "devicesPage.addGroup.server" };
const ADD_KIND: Record<DeviceGroup, AddKind> = { phones: "phone", computers: "computer", servers: "server" };

export function DevicesPage() {
  const { ctx, place, go, setSub } = useSettingsShell();
  const dispatch = useStoreDispatch();
  const config = useStoreSelector((state) => state.config);
  const { devices, companion, refresh } = useDevices({ here: ctx.here, client: ctx.client, name: place.name, kind: place.kind });
  const c = usePhoneSetupController(config?.profile?.email);
  const [open, setOpen] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [adding, setAdding] = useState<{ start: AddKind | null; from: string } | null>(null);
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

  const focusNode = (id: string) => window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-device-node="${CSS.escape(id)}"]`)?.focus());
  const startAdding = (start: AddKind | null, from: string) => { setNotice(null); setFailure(null); setAdding({ start, from }); };
  const networkAction = nextNetworkStep(network, { check: () => void check(), addComputer: () => startAdding("computer", "[data-network-action]") },
    { busy: c.busy, blocked: Boolean(blocked), platform: window.ogb?.platform });

  const environments = ctx.here ? window.ogb?.environments : undefined;
  const workspaces = ctx.here ? window.ogb?.workspaces : undefined;

  const act = async (device: Device, action: DeviceAction) => {
    setFailure(null);
    try {
      switch (action.type) {
        case "switch": await environments?.switch(action.placeId); return;
        case "retry": await environments?.retry?.(action.placeId); break;
        case "pair-again": setOpen(device.id); setPairing(true); return;
        case "copy-address": await copyText(action.address); return;
        case "copy-update": setOpen(device.id); setPairing(false); return;
        case "manage": go(action.page, action.anchor); return;
        case "remove": {
          // A device is removed whole: every way it is joined here goes (a phone's pairing and its app, a saved server and
          // its sign-in).
          const sources = device.actions.flatMap((one) => (one.type === "remove" ? [one.source] : []));
          for (const source of sources) {
            if (source.type === "place") await environments?.forget(source.id);
            else if (source.type === "phone") await c.act((bridge) => bridge.revoke(source.id));
            else if (source.type === "phone-app") await api(phoneRemovePath(source.id), { method: "DELETE" });
            else if (source.type === "session") await api(`/api/auth/sessions/${encodeURIComponent(source.id)}`, { method: "DELETE" });
          }
          if (open === device.id) setOpen(null);
          setNotice(t("devicesPage.removed", { name: device.name }));
          break;
        }
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
    refresh();
  };

  const close = () => {
    const id = open;
    setOpen(null);
    setPairing(false);
    if (id) focusNode(id === "here" ? "here" : id);
  };
  const opened: Opened = {
    id: open, pairing,
    toggle: (id) => { setNotice(null); setPairing(false); setOpen((now) => (now === id ? null : id)); },
    close,
    onPairing: (device, on, connected) => { setPairing(on); if (connected) { setNotice(t("devicesPage.pairedAgain", { name: device.name })); refresh(); } },
    onRemoved: (text) => { setOpen(null); setNotice(text); refresh(); },
  };

  if (adding) {
    const leave = (id?: string) => {
      const from = adding.from;
      setAdding(null);
      refresh();
      if (id) { setOpen(id); focusNode(id); }
      else window.requestAnimationFrame(() => document.querySelector<HTMLElement>(from)?.focus());
    };
    return <AddDevicePanel here={ctx.here} cloud={ctx.cloud} devices={devices} network={network} networkAction={networkAction}
      tailnetAddress={companion?.tailnetShare?.origin ?? null} start={adding.start} onBack={leave} onConnected={refresh}
      phoneSteps={ctx.here && c.state ? (onClose) => <PairPhoneSteps c={c} state={c.state!} onClose={() => { refresh(); onClose(); }} codeView={<PhoneCodeInline c={c} />} /> : null}
      setSub={setSub}
      canConnectServer={Boolean(workspaces?.add)} onCheck={() => void check()} checking={c.busy}
      onGetCloud={workspaces?.add ? () => { setAdding(null); dispatch({ type: "toggleAppSettings", open: false }); void workspaces.add?.("cloud"); } : null} />;
  }

  const here = devices.find((device) => device.here)!;
  const mark = place.kind === "computer" ? <SettingsMark><Laptop /></SettingsMark> : <PlaceBadge place={place} size={28} />;
  const groups = groupByKind(devices, { all: true });
  const now = Date.now();
  // At most one quiet button beside the next step: ask again after installing, open the admin console, or manage.
  const secondary = !network || blocked ? null
    : networkAction?.href ? <button type="button" className="settings-quiet cursor-pointer" disabled={c.busy} onClick={() => void check()}>{c.busy ? t("common.checking") : t("remote.checkAgain")}</button>
    : network.state === "needs-approval" ? <a className="settings-quiet" href={TAILSCALE_ADMIN} target="_blank" rel="noreferrer">{t("devicesPage.network.approveIn")}</a>
    : network.state === "ready" && network.shared ? <button type="button" className="settings-quiet cursor-pointer" onClick={() => go("phone", "computers")}>{t("devicesPage.action.manage")}</button> : null;
  return <>
    {failure && <p role="alert" className="px-4 text-[13px] leading-[18px] text-danger">{failure}</p>}
    {notice && <p role="status" data-devices-notice="" className="px-4 text-[13px] leading-[18px] text-ink-secondary">{notice}</p>}
    <HereSection device={here} mark={mark} opened={opened} onAction={(device, action) => void act(device, action)} onAdd={() => startAdding(null, "[data-add-device]")} now={now}
      network={network && { network, line: blocked ?? networkLine(network), action: networkAction, secondary }} />
    {groups.map((entry) => (
      <GroupSection key={entry.group} group={entry.group} devices={entry.devices} opened={opened} onAction={(device, action) => void act(device, action)} now={now}
        addLabel={t(ADD_LABEL[entry.group])}
        onAdd={() => startAdding(ADD_KIND[entry.group], `[data-add-group="${entry.group}"]`)} />
    ))}
  </>;
}
