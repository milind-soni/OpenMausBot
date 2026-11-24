import { useId, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, Waypoints } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Device, DeviceAction, DeviceGroup, PrivateNetwork } from "@/lib/devices";
import { SettingsEmptyRow, SettingsGroup, SettingsMark, SettingsRows } from "../SettingsPrimitives";
import { actionLabel, DeviceDetails } from "./DeviceDetails";
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
  onRemoved: (notice: string | null) => void;
}

const SLOT = "flex size-8 shrink-0 items-center justify-center text-ink-secondary";

/**
 * One device: its kind's mark, its name, its state and how it connects in one line, the bots on it, and the one thing it
 * needs. The whole row opens its details right under it, in the same card; Escape there closes them.
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
  const onKey = (event: KeyboardEvent) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    opened.close();
  };
  return (
    <div data-device-row={device.id} data-device-status={device.status} data-open={open ? "" : undefined} onKeyDown={onKey}>
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
        {open && <DeviceDetails device={device} onAction={onAction} now={now} pairing={opened.pairing}
          onPairing={(on, connected) => opened.onPairing(device, on, connected)} onRemoved={opened.onRemoved} />}
      </div>
    </div>
  );
}

const NETWORK_MARK: Partial<Record<PrivateNetwork["state"], Device["status"]>> = { ready: "online", unknown: "unknown" };

/** The private network on this computer: its state, the whole next step in words, and the one button for it. */
function NetworkRow({ network, line, action, secondary }: { network: PrivateNetwork; line: string; action: NetworkAction | null; secondary?: ReactNode }) {
  return (
    <div data-settings-block="network" data-private-network="" className="flex scroll-mt-4 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="flex min-w-[min(100%,14rem)] flex-1 gap-3">
        <span aria-hidden="true" className={SLOT}><SettingsMark><Waypoints /></SettingsMark></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 text-[14px] leading-5 text-ink">
            {t("devicesPage.network.title")}
            <span data-network-state={network.state} className={cn("flex items-center gap-1.5 text-[13px] leading-[18px]", (network.state === "ready" && network.shared) || network.state === "unknown" ? "text-ink-secondary" : "text-ink")}>
              <StatusMark status={network.state === "ready" && !network.shared ? "attention" : NETWORK_MARK[network.state] ?? "attention"} />{networkShort(network)}
            </span>
          </span>
          <span data-network-line={network.state} aria-live="polite" className="text-[13px] leading-[18px] text-ink-secondary">{line}</span>
        </div>
      </div>
      {(action || secondary) && (
        <span className="flex shrink-0 items-center gap-2 ps-11 @min-[480px]/rows:ps-0">
          {action && (action.href
            ? <a href={action.href} target="_blank" rel="noreferrer" className="ui-button ui-button-sm" data-network-action="">{action.label}</a>
            : <button type="button" className="ui-button ui-button-sm" data-network-action="" disabled={action.busy} onClick={action.run}>{action.label}</button>)}
          {secondary}
        </span>
      )}
    </div>
  );
}

/** This place first: its row (open like any other) and, on This computer, the private network under it. */
export function HereSection({ device, mark, network, opened, onAction, onAdd, now }: {
  device: Device; mark: ReactNode; opened: Opened; onAction: (device: Device, action: DeviceAction) => void; onAdd: () => void; now: number;
  network: { network: PrivateNetwork; line: string; action: NetworkAction | null; secondary?: ReactNode } | null;
}) {
  return (
    <SettingsGroup label={t("devicesPage.here.section")} block="add"
      actions={<button type="button" data-add-device="" onClick={onAdd} className="ui-button ui-button-primary ui-button-sm">{t("devicesPage.add")}</button>}>
      <SettingsRows icons>
        <DeviceRow device={device} mark={mark} opened={opened} onAction={onAction} now={now} />
        {network && <NetworkRow {...network} />}
      </SettingsRows>
    </SettingsGroup>
  );
}

/** One group of devices by what a person calls them, with its own Add and a line while it has none. */
export function GroupSection({ group, devices, addLabel, onAdd, opened, onAction, now }: {
  group: DeviceGroup; devices: readonly Device[]; addLabel: string | null; onAdd: () => void; opened: Opened;
  onAction: (device: Device, action: DeviceAction) => void; now: number;
}) {
  return (
    <SettingsGroup label={groupLabel(group)} block={`group-${group}`}
      actions={addLabel && <button type="button" data-add-group={group} onClick={onAdd} className="settings-quiet cursor-pointer">{addLabel}</button>}>
      <SettingsRows icons>
        {devices.length
          ? devices.map((device) => <DeviceRow key={device.id} device={device} opened={opened} onAction={onAction} now={now} />)
          : <SettingsEmptyRow><span data-devices-empty={group}>{t(EMPTY[group])}</span></SettingsEmptyRow>}
      </SettingsRows>
    </SettingsGroup>
  );
}

const EMPTY = { phones: "devicesPage.empty.phones", computers: "devicesPage.empty.computers", servers: "devicesPage.empty.servers" } as const;
