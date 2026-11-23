import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { lastSeen } from "@/lib/pairing-time";
import { deviceGroup, type Device, type DeviceAction, type DeviceGroup } from "@/lib/devices";
import { SettingsGroup, SettingsRows } from "../SettingsPrimitives";
import { DOT, KIND_ICON, groupLabel, kindLabel, routeLabel, statusText } from "./device-words";

const GROUPS: readonly DeviceGroup[] = ["computers", "servers", "phones"];

function actionLabel(action: DeviceAction, device: Device): string {
  switch (action.type) {
    case "switch": return t("servers.switch");
    case "retry": return t("servers.tryNow");
    case "pair-again": return t("servers.pairAgain");
    case "copy-address": return t("servers.copyAddress");
    case "copy-update": return t("devicesPage.action.copyUpdate");
    case "manage": return t("devicesPage.action.manage");
    case "remove": return device.sources.length > 1 && action.source.type === "phone-app" ? t("devicesPage.action.removeApps") : t("remote.devices.removeShort");
  }
}

/** The row's one button beside its name: what it most needs, else Switch. The rest show once it is chosen. */
const PRIMARY: ReadonlyArray<DeviceAction["type"]> = ["copy-update", "retry", "pair-again", "switch", "manage"];
const primaryOf = (device: Device) => PRIMARY.map((type) => device.actions.find((action) => action.type === type)).find(Boolean);

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <dt className="w-28 shrink-0 text-[12px] leading-4 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] leading-[18px] text-ink-secondary">{children}</dd>
    </div>
  );
}

function DeviceRow({ device, selected, onSelect, onAction, now }: { device: Device; selected: boolean; onSelect: (id: string | null) => void; onAction: (device: Device, action: DeviceAction) => void; now: number }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const Icon = KIND_ICON[device.kind];
  const dot = DOT[device.status];
  const primary = primaryOf(device);
  const rest = device.actions.filter((action) => action !== primary);
  const button = (action: DeviceAction, quiet: boolean) => (
    <button key={`${action.type}:${"source" in action ? action.source.id : ""}`} type="button" data-device-action={action.type}
      data-danger={action.type === "remove" ? "" : undefined} onClick={() => onAction(device, action)}
      aria-label={`${actionLabel(action, device)}: ${device.name}`}
      className={quiet ? "settings-quiet shrink-0 cursor-pointer" : "ui-button shrink-0"}>{actionLabel(action, device)}</button>
  );
  return (
    <div ref={row} data-device-row={device.id} data-selected={selected ? "" : undefined} className={cn("flex flex-col scroll-mt-4", selected && "bg-ink/[0.04]")}>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2">
        <span className="relative flex size-8 shrink-0 items-center justify-center text-ink-secondary">
          <Icon size={16} aria-hidden="true" />
          {dot && <span aria-hidden="true" className={cn("absolute bottom-1 right-1 size-2 rounded-full", dot)} />}
        </span>
        <button type="button" aria-expanded={selected} onClick={() => onSelect(selected ? null : device.id)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          <span className="truncate text-[14px] leading-5 text-ink">{device.name}</span>
          <span className={cn("truncate text-[13px] leading-[18px]", device.status === "attention" ? "text-warning" : "text-ink-secondary")}>
            {statusText(device, now)}{device.here ? "" : ` · ${routeLabel(device.route)}`}
          </span>
        </button>
        {primary && button(primary, false)}
      </div>
      {selected && (
        <div className="flex flex-col gap-3 pb-3 pe-4 ps-[60px]" data-device-details="">
          <dl className="flex flex-col gap-1.5">
            <Detail label={t("devicesPage.detail.kind")}>{kindLabel(device.kind)}</Detail>
            {!device.here && <Detail label={t("devicesPage.detail.reaches")}>{device.routes.map(routeLabel).join(", ")}</Detail>}
            {device.address && <Detail label={t("devicesPage.detail.address")}><span className="select-text font-mono text-[12px]">{device.address}</span></Detail>}
            {device.version && <Detail label={t("devicesPage.detail.version")}>{device.version}</Detail>}
            {device.lastSeen && device.status !== "online" && <Detail label={t("devicesPage.detail.lastSeen")}>{lastSeen(device.lastSeen, now)}</Detail>}
            <Detail label={t("devicesPage.detail.bots")}>
              {device.canRunBots ? t("devicesPage.detail.runsBots") : device.canHostComputer ? t("devicesPage.detail.hostsComputer") : t("devicesPage.detail.reachesBots")}
            </Detail>
          </dl>
          {rest.length > 0 && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{rest.map((action) => button(action, true))}</div>}
        </div>
      )}
    </div>
  );
}

/** Under the map: every device by what it is, with the actions that already exist for it. */
export function DeviceList({ devices, selected, onSelect, onAction, now = Date.now() }: {
  devices: readonly Device[]; selected: string | null; onSelect: (id: string | null) => void; onAction: (device: Device, action: DeviceAction) => void; now?: number;
}) {
  return <>
    {GROUPS.map((group) => {
      const listed = devices.filter((device) => deviceGroup(device) === group);
      if (listed.length === 0) return null;
      return (
        <SettingsGroup key={group} label={groupLabel(group)} block={`devices-${group}`}>
          <SettingsRows icons>
            {listed.map((device) => <DeviceRow key={device.id} device={device} selected={selected === device.id} onSelect={onSelect} onAction={onAction} now={now} />)}
          </SettingsRows>
        </SettingsGroup>
      );
    })}
  </>;
}
