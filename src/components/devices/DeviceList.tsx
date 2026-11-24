import { t } from "@/lib/i18n";
import { lastSeen } from "@/lib/pairing-time";
import type { Device, DeviceAction } from "@/lib/devices";
import { LendComputerSwitch } from "../LendComputerSwitch";
import { kindLabel, routeLabel } from "./device-words";

export function actionLabel(action: DeviceAction, device: Device): string {
  switch (action.type) {
    case "switch": return t("servers.switch");
    case "retry": return t("servers.tryNow");
    case "pair-again": return t("servers.pairAgain");
    case "copy-address": return t("servers.copyAddress");
    case "copy-update": return t("devicesPage.action.copyUpdate");
    case "manage": return t("devicesPage.action.manage");
    case "remove":
      if (device.sources.length > 1 && action.source.type === "phone-app") return t("devicesPage.action.removeApps");
      if (device.sources.length > 1 && action.source.type === "session") return t("devicesPage.action.signOut");
      return t("remote.devices.removeShort");
  }
}

/** The card's one button beside its name: what it most needs, else Switch. The rest sit under its details. */
const PRIMARY: ReadonlyArray<DeviceAction["type"]> = ["copy-update", "retry", "pair-again", "switch", "manage"];
export const primaryOf = (device: Device) => PRIMARY.map((type) => device.actions.find((action) => action.type === type)).find(Boolean);

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <dt className="w-28 shrink-0 text-[12px] leading-4 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] leading-[18px] text-ink-secondary">{children}</dd>
    </div>
  );
}

export function ActionButton({ device, action, quiet, onAction }: { device: Device; action: DeviceAction; quiet: boolean; onAction: (device: Device, action: DeviceAction) => void }) {
  return (
    <button type="button" data-device-action={action.type} data-danger={action.type === "remove" ? "" : undefined} onClick={() => onAction(device, action)}
      aria-label={`${actionLabel(action, device)}: ${device.name}`}
      className={quiet ? "settings-quiet shrink-0 cursor-pointer" : "ui-button shrink-0"}>{actionLabel(action, device)}</button>
  );
}
const actionKey = (action: DeviceAction) => `${action.type}:${"source" in action ? action.source.id : ""}`;

/** A server saved by hand on This computer's own page: the saved id its lend switch is about. */
const lendsHere = (device: Device) => (window.ogb?.lendComputer?.wish && device.address && device.kind !== "cloud" ? device.sources.find((source) => source.type === "place")?.id ?? null : null);

/** What a device is, how it connects and what bots can do with it, then its other actions. */
export function DeviceDetails({ device, actions, onAction, now }: { device: Device; actions: readonly DeviceAction[]; onAction: (device: Device, action: DeviceAction) => void; now: number }) {
  return <>
    <dl className="flex flex-col gap-1.5">
      <Detail label={t("devicesPage.detail.kind")}>{kindLabel(device.kind)}</Detail>
      {!device.here && <Detail label={t("devicesPage.detail.reaches")}>{device.routes.map(routeLabel).join(", ")}</Detail>}
      {device.address && <Detail label={t("devicesPage.detail.address")}><span className="select-text font-mono text-[12px]">{device.address}</span></Detail>}
      {device.version && <Detail label={t("devicesPage.detail.version")}>{device.version}</Detail>}
      {device.lastSeen && device.status !== "online" && <Detail label={t("devicesPage.detail.lastSeen")}>{lastSeen(device.lastSeen, now)}</Detail>}
      <Detail label={t("devicesPage.detail.bots")}>
        {device.canRunBots ? t("devicesPage.detail.runsBots") : device.canHostComputer ? t("devicesPage.detail.hostsComputer") : t("devicesPage.detail.reachesBots")}
        {device.usesThisComputer && !lendsHere(device) && <span className="block">{t("servers.share.on", { name: device.name })}</span>}
      </Detail>
    </dl>
    {/* A server of the person's own, saved by hand: the same switch as its row in Your computers. */}
    {lendsHere(device) && <LendComputerSwitch id={lendsHere(device)!} />}
    {actions.length > 0 && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{actions.map((action) => <ActionButton key={actionKey(action)} device={device} action={action} quiet onAction={onAction} />)}</div>}
  </>;
}
