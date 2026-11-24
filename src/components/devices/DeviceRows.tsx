import { useEffect, useId, useRef, type ReactNode } from "react";
import { Check, ChevronRight, Waypoints, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Device, DeviceAction, DeviceGroup, PrivateNetwork } from "@/lib/devices";
import { SettingsEmptyRow, SettingsGroup, SettingsMark, SettingsRows, Switch } from "../SettingsPrimitives";
import { actionLabel, DeviceDetails, type DeviceExtra } from "./DeviceDetails";
import { BotsOn, botsLabel, needOf, StatusLine, StatusMark, useBotsOn } from "./device-parts";
import { KIND_ICON, groupLabel, networkShort, statusText } from "./device-words";

export interface NetworkAction {
  label: string;
  run?: () => void;
  href?: string;
  busy?: boolean;
}

/** What the open row's details need from the page. */
export interface Opened {
  id: string | null;
  pairing: boolean;
  toggle: (id: string) => void;
  close: () => void;
  onPairing: (device: Device, open: boolean, connected?: boolean) => void;
  onRemoved: (notice: string | null, device: Device) => void;
  /** More of an open device's details, from what only the page reads (a phone's own controls). */
  extra?: (device: Device) => DeviceExtra | undefined;
}

const SLOT = "flex size-8 shrink-0 items-center justify-center text-ink-secondary";

/**
 * One device: its kind's mark, its name, its state and how it connects in one line, the bots on it, and the one thing it
 * needs. The whole row opens its details right under it, in the same card; Escape closes them (the page listens).
 */
function DeviceRow({ device, mark, opened, onAction, now }: {
  device: Device; mark?: ReactNode; opened: Opened; onAction: (device: Device, action: DeviceAction) => void; now: number;
}) {
  const Icon = KIND_ICON[device.kind];
  const bots = useBotsOn(device);
  const need = needOf(device);
  const open = opened.id === device.id;
  const detailsId = useId();
  const node = device.here ? "here" : device.id;
  const label = [device.name, statusText(device, now), botsLabel(bots)].filter(Boolean).join(", ");
  return (
    <div data-device-row={device.id} data-device-status={device.status} data-open={open ? "" : undefined} className="scroll-mt-4">
      <div className="relative flex min-h-11 items-center gap-3 px-4 py-3">
        <span aria-hidden="true" className={SLOT}>{mark ?? <SettingsMark><Icon /></SettingsMark>}</span>
        <button type="button" data-device-node={node} aria-expanded={open} aria-controls={detailsId} aria-label={label} title={device.name}
          onClick={() => opened.toggle(device.id)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-start after:absolute after:inset-0 after:content-[''] hover:after:bg-ink/[0.03] focus-visible:outline-none! focus-visible:after:rounded-xl focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus">
          <span className="break-words text-[14px] font-medium leading-5 text-ink">{device.name}</span>
          <StatusLine device={device} now={now} />
          {bots.length > 0 && <span className="pt-1 @min-[480px]/rows:hidden"><BotsOn bots={bots} /></span>}
        </button>
        {bots.length > 0 && <span className="hidden @min-[480px]/rows:flex"><BotsOn bots={bots} /></span>}
        {need && !open && (
          <button type="button" data-row-action={need.type} onClick={() => onAction(device, need)} aria-label={`${actionLabel(need)}: ${device.name}`}
            className="ui-button ui-button-sm relative z-10 shrink-0">{actionLabel(need)}</button>
        )}
        <ChevronRight size={14} aria-hidden="true" className={cn("-me-1 shrink-0 text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100", open && "rotate-90")} />
      </div>
      <div id={detailsId} hidden={!open} data-device-details={open ? device.id : undefined} className="ps-[60px] pe-4 pb-4 motion-safe:animate-fade-in">
        {open && <DeviceDetails device={device} onAction={onAction} now={now} pairing={opened.pairing} extra={opened.extra?.(device)}
          onPairing={(on, connected) => opened.onPairing(device, on, connected)} onRemoved={(text) => opened.onRemoved(text, device)} />}
      </div>
    </div>
  );
}

const NETWORK_MARK: Partial<Record<PrivateNetwork["state"], Device["status"]>> = { ready: "online", unknown: "unknown" };
/** The private network's mark: a choice left off reads as away, not as needing the person. */
export const networkMark = (network: PrivateNetwork): Device["status"] => (network.state === "ready" && !network.shared ? "offline" : NETWORK_MARK[network.state] ?? "attention");

/** Your other computers on the private network, as a switch once Tailscale is on: on lets them open this computer. */
export interface NetworkShare {
  on: boolean;
  busy: boolean;
  /** The organization keeps remote access off: it can be turned off, never on. */
  blocked: boolean;
  onToggle: () => void;
  /** Tailscale stays on for phones after the share is off: this turns it off for them too. */
  onPhonesOff: (() => void) | null;
}

/** The private network on this computer: its state, the whole next step in words, and the one control for it. */
function NetworkRow({ network, line, action, secondary, share }: { network: PrivateNetwork; line: string; action: NetworkAction | null; secondary?: ReactNode; share?: NetworkShare | null }) {
  const shareLabel = t("devicesPage.network.shareSwitch");
  return (
    <div data-settings-block="computers" className="contents">
      <div data-settings-block="network" data-private-network="" className="flex scroll-mt-4 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="flex min-w-[min(100%,14rem)] flex-1 gap-3">
          <span aria-hidden="true" className={SLOT}><SettingsMark><Waypoints /></SettingsMark></span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 text-[14px] leading-5 text-ink">
              {t("devicesPage.network.title")}
              <span data-network-state={network.state} className={cn("flex items-center gap-1.5 text-[13px] leading-[18px]", networkMark(network) === "attention" ? "text-ink" : "text-ink-secondary")}>
                <StatusMark status={networkMark(network)} />{networkShort(network)}
              </span>
            </span>
            <span data-network-line={network.state} aria-live="polite" className="text-[13px] leading-[18px] text-ink-secondary">{line}</span>
            {share?.onPhonesOff && <span data-network-phones="" className="flex flex-wrap items-center gap-x-2 text-[13px] leading-[18px] text-ink-secondary">
              {t("devicesPage.network.phonesStill")}
              <button type="button" data-network-phones-off="" className="settings-quiet -ms-1.5 cursor-pointer" disabled={share.busy} onClick={share.onPhonesOff}>{t("devicesPage.network.phonesOff")}</button>
            </span>}
          </div>
        </div>
        {(action || secondary || share) && (
          <span className="ms-auto flex shrink-0 items-center gap-2 ps-11 @min-[480px]/rows:ps-0">
            {action && (action.href
              ? <a href={action.href} target="_blank" rel="noreferrer" className="ui-button ui-button-sm" data-network-action="">{action.label}</a>
              : <button type="button" className="ui-button ui-button-sm" data-network-action="" disabled={action.busy} onClick={action.run}>{action.label}</button>)}
            {secondary}
            {share && <label className="flex cursor-pointer items-center gap-2 text-[13px] leading-[18px] text-ink">
              {shareLabel}
              <Switch checked={share.on} aria-label={shareLabel} data-network-share={share.on ? "on" : "off"}
                disabled={share.busy || (share.blocked && !share.on)} onClick={share.onToggle} />
            </label>}
          </span>
        )}
      </div>
    </div>
  );
}

/** This place first: its row (open like any other) and, on This computer, the private network under it (`network`, or
 * `pending` while it is still being read). */
export function HereSection({ device, mark, network, pending = false, opened, onAction, onAdd, now, more }: {
  device: Device; mark: ReactNode; opened: Opened; onAction: (device: Device, action: DeviceAction) => void; onAdd: () => void; now: number;
  network: { network: PrivateNetwork; line: string; action: NetworkAction | null; secondary?: ReactNode; share?: NetworkShare | null } | null;
  pending?: boolean;
  /** more rows of this place's own, under it */
  more?: ReactNode;
}) {
  return (
    <SettingsGroup label={t("devicesPage.here.section")} block="add"
      actions={<button type="button" data-add-device="" onClick={onAdd} className="ui-button ui-button-primary ui-button-sm">{t("devicesPage.add")}</button>}>
      <SettingsRows icons>
        <DeviceRow device={device} mark={mark} opened={opened} onAction={onAction} now={now} />
        {network && <NetworkRow {...network} />}
        {more}
      </SettingsRows>
      {!network && pending && <span data-settings-block="network" className="contents"><span data-settings-block="computers" className="contents" /></span>}
    </SettingsGroup>
  );
}

/** What just happened to a device (removed, paired again), by the list it happened in, until it is closed or the page moves on. */
export function DevicesNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => { line.current?.scrollIntoView?.({ block: "nearest" }); }, [text]);
  return (
    <div ref={line} role="status" className="flex scroll-mt-4 items-center gap-3 rounded-[12px] bg-menu py-1.5 ps-4 pe-2 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success"><Check size={12} strokeWidth={2.5} /></span>
      <span data-devices-notice="" className="min-w-0 flex-1 py-1 text-[13px] font-medium leading-[18px] text-ink">{text}</span>
      <button type="button" data-devices-notice-close="" aria-label={t("notice.dismiss")} title={t("notice.dismiss")} onClick={onDismiss} className="ui-icon-button size-7 shrink-0"><X size={14} aria-hidden="true" /></button>
    </div>
  );
}

/** One group of devices by what a person calls them, with its own Add and a line while it has none. `notes` sit under its
 * title; `lead` rows come before its devices in the same card. */
export function GroupSection({ group, devices, addLabel, onAdd, opened, onAction, now, block = `group-${group}`, notes, lead, notice }: {
  group: DeviceGroup; devices: readonly Device[]; addLabel: string | null; onAdd: () => void; opened: Opened;
  onAction: (device: Device, action: DeviceAction) => void; now: number; block?: string; notes?: ReactNode; lead?: ReactNode; notice?: ReactNode;
}) {
  return (
    <SettingsGroup label={groupLabel(group)} block={block}
      actions={addLabel && <button type="button" data-add-group={group} data-phone-pairing-action={group === "phones" ? "" : undefined} onClick={onAdd} className="settings-quiet cursor-pointer">{addLabel}</button>}>
      {notes}
      {notice}
      <SettingsRows icons>
        {lead}
        {devices.length
          ? devices.map((device) => <DeviceRow key={device.id} device={device} opened={opened} onAction={onAction} now={now} />)
          : <SettingsEmptyRow><span data-devices-empty={group}>{t(EMPTY[group])}</span></SettingsEmptyRow>}
      </SettingsRows>
    </SettingsGroup>
  );
}

const EMPTY = { phones: "devicesPage.empty.phones", computers: "devicesPage.empty.computers", servers: "devicesPage.empty.servers" } as const;
