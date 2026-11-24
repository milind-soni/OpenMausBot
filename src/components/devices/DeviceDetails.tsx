import { useEffect, useRef, useState, type ReactNode } from "react";
import { BotAvatar } from "@/components/Avatar";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { lastSeen } from "@/lib/pairing-time";
import type { Device, DeviceAction } from "@/lib/devices";
import { vpsServerId } from "../../../shared/bot-computers";
import { VpsServerEditor } from "../keys/VpsServerEditor";
import { LendComputerSwitch } from "../LendComputerSwitch";
import { OwnServerLink } from "../PlaceAddSheet";
import { updateCommand } from "../ServerList";
import { needOf, useBotsOn } from "./device-parts";
import { CommandRow } from "./PairCodePanel";
import { kindLabel, routeLabel } from "./device-words";

export function actionLabel(action: DeviceAction, device?: Device): string {
  switch (action.type) {
    case "switch": return t("devicesPage.action.goToBots");
    case "retry": return t("devicesPage.action.tryAgain");
    case "pair-again": return t("servers.pairAgain");
    case "copy-address": return t("servers.copyAddress");
    case "copy-update": return t("devicesPage.action.howToUpdate");
    case "manage": return t("devicesPage.action.manage");
    case "turn-on-way": return t("devicesPage.action.turnOnWay");
    case "remove":
      if (device && device.kind !== "phone" && signsIn(device)) {
        if (action.source.type === "session") return t("devicesPage.action.signOut");
        if (action.source.type === "place") return t("devicesPage.action.removeHere");
      }
      return t("remote.devices.removeShort");
  }
}

/** A saved server that is also signed in to this computer: its Remove and its Sign it out undo different things. */
const signsIn = (device: Device) => device.sources.some((source) => source.type === "session") && device.sources.some((source) => source.type === "place");

export interface DeviceExtra {
  facts?: ReactNode;
  controls?: ReactNode;
}

/** A server bots reach over SSH: the id its editor takes. */
export const vpsOf = (device: Device): string | null => {
  const source = device.sources.find((one) => one.type === "vps");
  return source ? vpsServerId(source.id) : null;
};

/** A server saved by hand on This computer's own page: the saved id its lend switch is about. */
const lendsHere = (device: Device) => (window.ogb?.lendComputer?.wish && device.address && device.kind !== "cloud" ? device.sources.find((source) => source.type === "place")?.id ?? null : null);

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 @min-[440px]/rows:flex-row @min-[440px]/rows:items-baseline @min-[440px]/rows:gap-3">
      <dt className="shrink-0 text-[12px] leading-4 text-ink-tertiary @min-[440px]/rows:w-24">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] leading-[18px] text-ink-secondary">{children}</dd>
    </div>
  );
}

export function ActionButton({ device, action, onAction, main = false }: { device: Device; action: DeviceAction; onAction: (device: Device, action: DeviceAction) => void; main?: boolean }) {
  return (
    <button type="button" data-device-action={action.type} data-danger={action.type === "remove" ? "" : undefined} onClick={() => onAction(device, action)}
      aria-label={`${actionLabel(action, device)}: ${device.name}`} className={action.type === "remove" ? "ui-button shrink-0 text-danger!" : main ? "ui-button ui-button-primary shrink-0" : "ui-button shrink-0"}>{actionLabel(action, device)}</button>
  );
}
/** What it needs first, then the harmless actions; apart from them, Remove (one for a phone, which takes its pairing and its app). */
function orderActions(device: Device): { lead: DeviceAction[]; removes: DeviceAction[] } {
  const need = needOf(device);
  const removes = device.actions.filter((action) => action.type === "remove");
  const rest = device.actions.filter((action) => action.type !== "remove" && action !== need);
  return { lead: [...(need ? [need] : []), ...rest], removes: device.kind === "phone" ? removes.slice(0, 1) : removes };
}

const actionKey = (action: DeviceAction) => `${action.type}:${"source" in action ? action.source.id : ""}`;

/** The bots that work on it by face and name; with none, what bots can do with it. */
function BotsDetail({ device }: { device: Device }) {
  const bots = useBotsOn(device);
  if (bots.length) {
    return <ul data-device-bot-names="" className="flex flex-wrap gap-x-3 gap-y-1">
      {bots.map((bot) => <li key={bot.id} className="flex min-w-0 items-baseline gap-1.5 text-ink"><span className="self-center"><BotAvatar bot={bot} size={16} /></span><span className="break-words">{bot.name}</span></li>)}
    </ul>;
  }
  return <>{device.canRunBots ? t("devicesPage.detail.runsBots") : device.canHostComputer ? t("devicesPage.detail.hostsComputer") : t("devicesPage.detail.reachesBots")}</>;
}

/**
 * A device's details, open under its row: what it is, how it connects and which bots work on it; the update command when
 * it needs one; the lend switch or a server's own editor; then its other actions. Pair again opens its form right here.
 */
export function DeviceDetails({ device, onAction, onRemoved, now, pairing, onPairing, extra }: {
  device: Device; onAction: (device: Device, action: DeviceAction) => void; onRemoved: (notice: string | null) => void; now: number;
  /** Pair again's form is open in place of the actions. */
  pairing: boolean;
  onPairing: (open: boolean, connected?: boolean) => void;
  /** What only the page knows of it: more facts for the list, and its own controls (a paired phone's). */
  extra?: DeviceExtra;
}) {
  const need = needOf(device);
  const update = device.actions.find((action) => action.type === "copy-update");
  const pairAgain = device.actions.find((action) => action.type === "pair-again");
  const { lead, removes } = orderActions(device);
  const actions = lead.filter((action) => action.type !== "copy-update");
  const act = (chosen: Device, action: DeviceAction) => (action.type === "pair-again" ? onPairing(true) : onAction(chosen, action));
  const vps = vpsOf(device);
  const lend = lendsHere(device);
  const [version] = useState(() => window.ogb?.app?.version ?? "");
  const pairForm = useRef<HTMLDivElement>(null);
  // Pair again keeps the device it is for in view: the row's own name sits right above its form.
  useEffect(() => { if (pairing) pairForm.current?.closest("[data-device-row]")?.scrollIntoView?.({ block: "start" }); }, [pairing]);
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2">
        <Detail label={t("devicesPage.detail.type")}>{kindLabel(device.kind)}</Detail>
        {!device.here && device.routes.length > 0 && <Detail label={t("devicesPage.detail.connectedBy")}>{device.routes.map(routeLabel).join(", ")}</Detail>}
        {device.address && <Detail label={t("devicesPage.detail.address")}><span className="select-text break-all font-mono text-[12px]">{device.address}</span></Detail>}
        {device.version && <Detail label={t("devicesPage.detail.version")}>{device.version}</Detail>}
        {device.lastSeen && device.status !== "online" && <Detail label={t("devicesPage.detail.lastSeen")}>{lastSeen(device.lastSeen, now)}</Detail>}
        {device.access && <Detail label={t("devicesPage.detail.access")}>{t(device.access === "full" ? "remote.serverPairing.scope.admin" : "remote.serverPairing.scope.client")}</Detail>}
        {device.email && <Detail label={t("devicesPage.detail.email")}><span className="select-text">{device.email}</span></Detail>}
        {extra?.facts}
        <Detail label={t("devicesPage.detail.bots")}><BotsDetail device={device} /></Detail>
      </dl>
      {device.note === "unreachable" && <p data-device-unreachable="" className="text-[13px] leading-[18px] text-ink-secondary">{t("devicesPage.detail.unreachableLine", { name: device.name })}</p>}
      {extra?.controls}
      {update?.type === "copy-update" && (
        <div data-device-update="" className="flex flex-col gap-1.5">
          <p className="text-[13px] leading-[18px] text-ink">{t("devicesPage.update.runPlain", { name: device.name, app: productName() })}</p>
          <CommandRow label="" command={updateCommand(update.install, version)} />
        </div>
      )}
      {device.usesThisComputer && !lend && <p className="text-[13px] leading-[18px] text-ink-secondary">{t("servers.share.on", { name: device.name })}</p>}
      {lend && <LendComputerSwitch id={lend} look="setting" />}
      {vps && <div data-device-ssh-editor=""><VpsServerEditor serverId={vps} onRemoved={onRemoved} /></div>}
      {pairing && pairAgain?.type === "pair-again"
        ? <div ref={pairForm} data-device-pair-again="" className="flex flex-col gap-3">
          <p className="text-[13px] font-semibold leading-[18px] text-ink">{t("servers.pairAgainTitle", { name: device.name })}</p>
          <OwnServerLink inline onBack={null} onConnected={() => onPairing(false, true)} start={{ address: pairAgain.address, locked: true, title: "" }} expect={device.name}
            aside={<button type="button" className="ui-button" data-pair-again-cancel="" onClick={() => onPairing(false)}>{t("common.cancel")}</button>} />
        </div>
        : (actions.length > 0 || removes.length > 0) && <div className="flex flex-col gap-2">
          <div data-device-actions="" className="flex flex-wrap items-center gap-2">
            {actions.map((action) => <ActionButton key={actionKey(action)} device={device} action={action} main={action === need} onAction={act} />)}
            {removes.length > 0 && <span data-device-removes="" className="ms-auto flex flex-wrap justify-end gap-2">
              {removes.map((action) => <ActionButton key={actionKey(action)} device={device} action={action} onAction={act} />)}
            </span>}
          </div>
          {removes.length > 1 && device.kind !== "phone" && signsIn(device) && <p data-device-remove-hint="" className="text-end text-[12px] leading-4 text-ink-tertiary">{t("devicesPage.action.signOutHint")}</p>}
        </div>}
    </div>
  );
}
