import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Laptop, Loader2 } from "lucide-react";
import { deviceGroup, privateNetwork, groupByKind, type Device, type DeviceAction, type DeviceGroup, type PrivateNetwork } from "@/lib/devices";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { showTunnelRetiredNotice } from "@/lib/phone-link";
import { revealPhonePairing, takePairOnOpen } from "@/lib/phone-pairing";
import { phoneRemovePath } from "@/lib/phones";
import { useDevices } from "@/lib/use-devices";
import type { CompanionState } from "@/lib/companion-types";
import { api } from "@/state/api";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { AddDevicePanel, lastInputWasKeys, withinPage, type AddKind } from "../../devices/AddDevicePanel";
import { DevicesAttention, DevicesNotice, GroupSection, HereSection, networkNeedsPerson, type NetworkAction, type NetworkShare, type Opened } from "../../devices/DeviceRows";
import { PhoneCodeInline } from "../../devices/CodeCard";
import { DeviceMap, deviceMapShown } from "../../devices/DeviceMap";
import { usePairAccess } from "../../devices/PairCodePanel";
import { ComputerNameMore, OtherPlacesSection, PairWithCloudRow, PhoneAppFacts, ServerPhoneNotes } from "../../devices/PhoneSections";
import { needsFirst, needsPerson } from "../../devices/device-parts";
import { networkLine, sshAliasOfAnchor } from "../../devices/device-words";
import { AlwaysOnHomeSection } from "../../AlwaysOnHomeSection";
import { PhoneControls } from "../../PairedPhones";
import { OpenCodeRow, PairPhoneSteps, ReachSection, RouteNotices, setCompanionTailscale, shouldResumePausedAddress, type PairAsk } from "../../PhoneDevicesSection";
import { companionAccountBridge, usePhoneSetupController } from "../../PhoneSetupFlow";
import { canPairDevices, pairingBlockedReason } from "../../ServerPairingCard";
import { SettingsGroup, SettingsMark } from "../../SettingsPrimitives";
import { PlaceBadge } from "../SettingsNav";
import { SettingsSkeletonCard } from "../SettingsStates";
import { devicesPlaceKey, setDevicesSignal } from "../devices-signal";
import { useSettingsShell } from "../settings-shell";

/** Tailscale's download page for this computer's system. */
export function tailscaleDownload(platform: string | undefined): string {
  if (platform === "darwin") return "https://tailscale.com/download/mac";
  if (platform === "win32") return "https://tailscale.com/download/windows";
  if (platform === "linux") return "https://tailscale.com/download/linux";
  return "https://tailscale.com/download";
}

/** The private network's one next step, for its row and the Add flow. Null while an organization turned remote access off. */
export function nextNetworkStep(network: PrivateNetwork | null, run: { check: () => void }, opts: { busy: boolean; blocked: boolean; platform?: string }): NetworkAction | null {
  if (!network || opts.blocked) return null;
  switch (network.state) {
    case "unknown": return { label: t("devicesPage.network.setUpTailscale"), run: run.check, busy: opts.busy };
    case "needs-approval": return { label: t("devicesPage.network.approveIn"), href: TAILSCALE_ADMIN };
    case "not-installed": return { label: t("remote.tailscale.getIt"), href: tailscaleDownload(opts.platform) };
    case "ready": return network.shared ? null : { label: t("devicesPage.network.allow"), run: run.check, busy: opts.busy };
    default: return { label: t("remote.checkAgain"), run: run.check, busy: opts.busy };
  }
}

/** Where a computer waiting for approval on the private network is approved. */
const TAILSCALE_ADMIN = "https://login.tailscale.com/admin/machines";

/** A recheck when the person comes back to the window: at most this often, and only after they asked once here. */
const RECHECK_MS = 5_000;

const ADD_LABEL: Record<DeviceGroup, Parameters<typeof t>[0]> = { phones: "devicesPage.addGroup.phone", computers: "devicesPage.addGroup.computer", servers: "devicesPage.addGroup.cloudOrServer" };
/** Each group's Add opens its own steps; Clouds and your own servers opens the choice, which has both. */
const ADD_KIND: Record<DeviceGroup, AddKind | null> = { phones: "phone", computers: "computer", servers: null };
const PHONES_ADD = "[data-add-group=phones]";

type Adding = { start: AddKind | null; from: string; keys: boolean; ask?: PairAsk };

export function DevicesPage() {
  const { ctx, place, go, setSub, setHeaderAction, anchor } = useSettingsShell();
  const dispatch = useStoreDispatch();
  const config = useStoreSelector((state) => state.config);
  const focus = useStoreSelector((state) => state.appSettingsPhonePairing);
  const { devices, companion: polled, phoneApps, loaded, refresh } = useDevices({ here: ctx.here, client: ctx.client, name: place.name, kind: place.kind });
  const c = usePhoneSetupController(config?.profile?.email);
  const access = usePairAccess();
  const [open, setOpen] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [problem, setProblem] = useState<CompanionState["tailscaleProblem"] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; group: DeviceGroup | null } | null>(null);
  const asked = useRef(0);
  const refreshNow = useRef(refresh);
  refreshNow.current = refresh;
  useEffect(() => { if (c.state) refreshNow.current(); }, [c.state]);
  const policy = config?.managedPolicy?.remoteAccess === false ? config.managedPolicy.organizationName : null;
  const blocked = policy ? t("policy.managedBy", { organization: policy }) : null;
  const companion = ctx.here ? c.state ?? polled : null;
  const network = ctx.here ? privateNetwork(companion, problem) : null;

  // The Tailscale checks, on a click only, never on load or in a poll: with its route off, the share (it checks, then
  // lets this computer's other computers open it); with it on, Check again, which asks Tailscale again.
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

  // Opening the page is what brings a paused address back: no button.
  const resumeAsked = useRef(false);
  const resumePaused = ctx.here && shouldResumePausedAddress(c.account, c.state);
  const { accountAct } = c;
  useEffect(() => {
    if (!resumePaused || resumeAsked.current || !companionAccountBridge()?.prepare) return;
    resumeAsked.current = true;
    void accountAct((remote) => remote.prepare?.() ?? remote.state());
  }, [resumePaused, accountAct]);

  const showReach = () => window.requestAnimationFrame(() => {
    const reach = document.querySelector<HTMLElement>("[data-settings-block=reach]");
    reach?.scrollIntoView?.({ block: "start" });
    reach?.querySelector<HTMLElement>("[role=switch]:not([disabled])")?.focus({ preventScroll: true });
  });
  const focusNode = (id: string) => window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-device-node="${CSS.escape(id)}"]`)?.focus());
  const startAdding = useCallback((start: AddKind | null, from: string, ask: PairAsk = null) => { setNotice(null); setFailure(null); setAdding({ start, from, keys: lastInputWasKeys(), ask }); }, []);

  // A link or the menu asked for pairing: Add a phone opens once (`pair=open`), else the section and its Add come into view.
  const pairAsked = useRef(false);
  const revealed = useRef(0);
  const pairReady = !ctx.here || Boolean(c.state);
  useEffect(() => {
    if (!focus) { revealed.current = 0; return; }
    if (revealed.current === focus || !pairReady) return;
    revealed.current = focus;
    if (takePairOnOpen()) { pairAsked.current = true; startAdding("phone", PHONES_ADD); }
    else revealPhonePairing(document.querySelector<HTMLElement>("[data-settings-block=phones]"));
  }, [focus, pairReady, startAdding]);
  // Another section asked for while Add is open: back to the list first, so the section is there to scroll to. The
  // section pair-on-open itself asked for keeps the Add it opened.
  const lastAnchor = useRef(anchor);
  useLayoutEffect(() => {
    if (lastAnchor.current === anchor) return;
    lastAnchor.current = anchor;
    const kept = pairAsked.current && anchor === "phones";
    pairAsked.current = false;
    if (anchor && !kept) setAdding(null);
  }, [anchor]);
  const openRow = (id: string) => {
    setNotice(null);
    setPairing(false);
    setOpen(id);
    window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-device-row="${CSS.escape(id)}"]`);
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      row?.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
      row?.querySelector<HTMLElement>("[data-device-node]")?.focus({ preventScroll: true });
    });
  };
  // A named server's row asked for from another page (its link on AI) opens once, when the server is listed.
  const openedFor = useRef<string | null>(null);
  const openRowNow = useRef(openRow);
  openRowNow.current = openRow;
  useEffect(() => {
    const alias = sshAliasOfAnchor(anchor);
    if (!alias) { openedFor.current = null; return; }
    if (openedFor.current === anchor) return;
    const server = devices.find((device) => device.sources.some((source) => source.type === "vps" && source.id === alias));
    if (!server) return;
    openedFor.current = anchor;
    openRowNow.current(server.id);
  }, [anchor, devices]);
  const networkAction = nextNetworkStep(network, { check: () => void check() },
    { busy: c.busy, blocked: Boolean(blocked), platform: window.ogb?.platform });
  const groups = groupByKind(devices, { all: true }).map((entry) => ({ ...entry, devices: needsFirst(entry.devices) }));
  const needing = groups.flatMap((entry) => entry.devices.filter(needsPerson));
  const networkNeeding = blocked ? null : network;
  const signalPlace = devicesPlaceKey(place);
  const needsYou = needing.length > 0 || networkNeedsPerson(networkNeeding);
  const phoneConnected = devices.some((device) => device.kind === "phone" && device.status === "online");
  useEffect(() => { if (loaded) setDevicesSignal({ place: signalPlace, needsYou, phoneConnected }); }, [loaded, signalPlace, needsYou, phoneConnected]);

  const isAdding = adding !== null;
  const addButton = useMemo(() => <span data-settings-block="add" className="flex scroll-mt-4">
    <button type="button" data-add-device="" onClick={() => startAdding(null, "[data-add-device]")} className="ui-button ui-button-primary ui-button-sm shrink-0">{t("devicesPage.add")}</button>
  </span>, [startAdding]);
  useLayoutEffect(() => {
    if (!setHeaderAction) return;
    setHeaderAction(isAdding ? null : addButton);
    return () => setHeaderAction(null);
  }, [setHeaderAction, isAdding, addButton]);

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
        case "turn-on-way": showReach(); return;
        case "remove": {
          // A phone is removed whole: its pairing and its app's registration are the same phone.
          const sources = device.kind === "phone" ? device.actions.flatMap((one) => (one.type === "remove" ? [one.source] : [])) : [action.source];
          for (const source of sources) {
            if (source.type === "place") await environments?.forget(source.id);
            else if (source.type === "phone" && !await c.act((bridge) => bridge.revoke(source.id))) { refresh(); return; }
            else if (source.type === "phone-app") await api(phoneRemovePath(source.id), { method: "DELETE" });
            else if (source.type === "session") await api(`/api/auth/sessions/${encodeURIComponent(source.id)}`, { method: "DELETE" });
          }
          if (open === device.id) setOpen(null);
          setNotice({ text: t("devicesPage.removed", { name: device.name }), group: deviceGroup(device) });
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
  // Escape closes the open details wherever focus is in the page (or nowhere, after Pair again closed), never Settings.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || adding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !withinPage(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, adding]);
  const phoneExtra = (device: Device) => {
    if (device.kind !== "phone") return undefined;
    const pairedId = device.sources.find((source) => source.type === "phone")?.id;
    const paired = pairedId ? c.state?.devices.find((phone) => phone.id === pairedId) : undefined;
    const appKey = device.sources.find((source) => source.type === "phone-app")?.id;
    const app = appKey ? phoneApps.find((phone) => phone.key === appKey) : undefined;
    return {
      facts: app && <PhoneAppFacts phone={app} />,
      controls: paired && <PhoneControls device={paired} c={c} onChanged={refresh}
        onPairAgain={policy ? undefined : () => startAdding("phone", `[data-device-node="${CSS.escape(device.id)}"]`)} />,
    };
  };
  const opened: Opened = {
    id: open, pairing,
    toggle: (id) => { setNotice(null); setPairing(false); setOpen((now) => (now === id ? null : id)); },
    close,
    onPairing: (device, on, connected) => { setPairing(on); if (connected) { setNotice({ text: t("devicesPage.pairedAgain", { name: device.name }), group: deviceGroup(device) }); refresh(); } },
    onRemoved: (text, device) => { setOpen(null); setNotice(text ? { text, group: deviceGroup(device) } : null); refresh(); },
    extra: phoneExtra,
  };

  if (adding) {
    const leave = (id?: string) => {
      const from = adding.from;
      setAdding(null);
      refresh();
      if (id) { setOpen(id); focusNode(id); }
      else window.requestAnimationFrame(() => document.querySelector<HTMLElement>(from)?.focus());
    };
    const phoneSteps = !ctx.here ? null
      : c.state ? <PairPhoneSteps c={c} state={c.state} ask={adding.ask} codeView={<PhoneCodeInline c={c} started={adding.ask === "https"} />} />
      : <p aria-busy="true" className="text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" /></p>;
    return <AddDevicePanel here={ctx.here} cloud={ctx.cloud} devices={devices} loaded={loaded} network={network} networkAction={networkAction}
      tailnetAddress={companion?.tailnetShare?.origin ?? null} start={adding.start} viaKeys={adding.keys} onBack={leave} onConnected={refresh}
      phoneSteps={phoneSteps} advanced={ctx.advanced} setSub={setSub}
      canConnectServer={Boolean(workspaces?.add)} onCheck={() => void check()} checking={c.busy}
      onGetCloud={workspaces?.add ? () => { setAdding(null); dispatch({ type: "toggleAppSettings", open: false }); void workspaces.add?.("cloud"); } : null} />;
  }

  const here = devices.find((device) => device.here)!;
  const mark = place.kind === "computer" ? <SettingsMark><Laptop /></SettingsMark> : <PlaceBadge place={place} size={28} />;
  const now = Date.now();
  const onAction = (device: Device, action: DeviceAction) => void act(device, action);
  const openNetwork = () => window.requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>("[data-private-network]");
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
    (row?.querySelector<HTMLElement>("a[href], button:not([disabled])") ?? row)?.focus({ preventScroll: true });
  });
  // Beside the next step, at most one quiet button: ask again after installing or approving.
  const secondary = network && !blocked && networkAction?.href
    ? <button type="button" className="settings-quiet cursor-pointer" disabled={c.busy} onClick={() => void check()}>{c.busy ? t("common.checking") : t("remote.checkAgain")}</button> : null;
  // Once Tailscale is on here, Your other computers is the row's switch, and it turns off as readily as on.
  const tailscaleOn = companion?.routes?.tailscale?.on === true;
  const share: NetworkShare | null = network && (network.state === "ready" || network.shared || tailscaleOn) ? {
    on: network.shared, busy: c.busy, blocked: Boolean(blocked),
    onToggle: () => void (network.shared ? c.act((bridge) => bridge.setTailscaleComputers?.(false) ?? bridge.state()).then(refresh) : check()),
    onPhonesOff: tailscaleOn && !network.shared ? () => void c.act((bridge) => setCompanionTailscale(bridge, false)).then(refresh) : null,
  } : null;
  const phoneBlocked = policy ? t("policy.remoteBlocked", { organization: policy }) : null;
  const teamMember = access.session?.kind === "session" && Boolean(access.session.team);
  const canAddPhone = ctx.here ? !policy : !teamMember && access.pairingCodes !== false && pairingBlockedReason(access.session) !== "chat-only";
  const state = ctx.here ? c.state : null;
  const phoneNotes: ReactNode = ctx.here ? <>
    {state && showTunnelRetiredNotice(c.account, state) && <p role="status" data-devices-notice="tunnel-retired" className="px-4 text-[12px] leading-4 text-warning">{t("remote.devices.retiredShort")}</p>}
    {phoneBlocked && <p role="status" data-phone-policy="" className="px-4 text-[12px] leading-4 text-ink-secondary">{phoneBlocked}</p>}
  </> : <ServerPhoneNotes session={access.session} pairingCodes={access.pairingCodes} team={config?.team?.name ?? null}
    teamBlocked={policy ? t("policy.teamRemoteBlocked", { organization: policy }) : null} />;
  const startPhone = (ask: PairAsk) => startAdding("phone", PHONES_ADD, ask);
  const error = failure ?? (ctx.here ? c.error ?? state?.error ?? null : null);
  const noticeLine = notice && <DevicesNotice text={notice.text} onDismiss={() => setNotice(null)} />;
  const mapShown = deviceMapShown();
  return <>
    {state && <RouteNotices c={c} notices={state.notices ?? []} />}
    {error && <p role="alert" className="px-4 text-[13px] leading-[18px] text-danger">{error}</p>}
    {notice && !notice.group && noticeLine}
    {!setHeaderAction && addButton}
    <DevicesAttention needing={needing} network={networkNeeding} now={now} onOpen={openRow} onNetwork={openNetwork} />
    {mapShown && <DeviceMap devices={devices} mark={mark} network={network} loaded={loaded} onOpen={openRow} now={now} />}
    <HereSection device={here} mark={mark} opened={opened} onAction={onAction} now={now} titled={!mapShown}
      network={network && { network, line: blocked ?? (network.state === "ready" && !network.shared ? null : networkLine(network)), action: network.state === "ready" ? null : networkAction, secondary, share }} pending={ctx.here}
      more={!ctx.here && ctx.advanced && !ctx.cloud && access.pairingCodes === true && canPairDevices(access.session) ? <ComputerNameMore /> : null} />
    {groups.map((entry) => {
      const phones = entry.group === "phones";
      return <div key={entry.group} className="contents">
        <GroupSection group={entry.group} devices={entry.devices} opened={opened} onAction={onAction} now={now}
          block={phones ? "phones" : undefined} notes={phones ? phoneNotes : undefined} notice={notice?.group === entry.group ? noticeLine : undefined}
          lead={phones && ctx.here ? <><PairWithCloudRow />{state && <OpenCodeRow c={c} state={state} />}</> : undefined}
          addLabel={phones && !canAddPhone ? null : t(ADD_LABEL[entry.group])}
          onAdd={() => startAdding(ADD_KIND[entry.group], `[data-add-group="${entry.group}"]`)} />
        {phones && ctx.here && (state
          ? <ReachSection c={c} state={state} simple={!ctx.advanced} moreWaysAsked={anchor === "more-ways"} managedBy={blocked} onPair={startPhone} />
          : <SettingsGroup label={t("phone.reach.title")} block="reach"><SettingsSkeletonCard place={place.name} /><span data-settings-block="more-ways" className="contents" /></SettingsGroup>)}
      </div>;
    })}
    {ctx.here && (state
      ? <AlwaysOnHomeSection c={c} state={state} blocked={blocked} onAddPhone={() => startPhone(null)}
        onAddComputer={() => startAdding("computer", "[data-always-on-add-computer]")} onConnect={() => startAdding("server", "[data-always-on-connect]")} />
      : <span data-settings-block="always-on" className="contents" />)}
    <OtherPlacesSection devices={devices} />
  </>;
}
