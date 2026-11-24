import { useId, type ReactNode } from "react";
import { Waypoints } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { groupByKind, type Device, type DeviceGroup, type PrivateNetwork } from "@/lib/devices";
import type { LocaleKey } from "@/locales";
import { networkMark } from "./DeviceRows";
import { BotFaces, botsLabel, markOf, routeOf, StatusMark, useBotsOn } from "./device-parts";
import { kindLabel, networkShort, statusText } from "./device-words";

/** The picture of this place's devices above the list. Flip to false to ship the page without it. */
export const SHOW_DEVICE_MAP = true;

let shownOverride: boolean | null = null;
/** For the preview and tests, which show both variants: null goes back to `SHOW_DEVICE_MAP`. */
export function overrideDeviceMap(shown: boolean | null) {
  shownOverride = shown;
}
export const deviceMapShown = () => shownOverride ?? SHOW_DEVICE_MAP;

const LINE = "border-ink-secondary/35";
const away = (devices: readonly Device[]) => devices.length > 0 && devices.every((device) => device.status === "offline");

const GROUP: Record<DeviceGroup, LocaleKey> = { phones: "devicesPage.group.phones", computers: "devicesPage.group.computers", servers: "devicesPage.group.servers" };
const COUNT: Record<DeviceGroup, [LocaleKey, LocaleKey]> = {
  phones: ["devicesPage.map.phonesOne", "devicesPage.map.phonesMany"],
  computers: ["devicesPage.map.computersOne", "devicesPage.map.computersMany"],
  servers: ["devicesPage.map.serversOne", "devicesPage.map.serversMany"],
};

const NODE = "relative flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full text-start transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";

/** This place, where every line starts: its mark, name, the bots on it and, on This computer, the private network as part of it. */
function Hub({ device, mark, network, onOpen }: { device: Device; mark: ReactNode; network: PrivateNetwork | null; onOpen: (id: string) => void }) {
  const bots = useBotsOn(device);
  const label = [device.name, t("devicesPage.status.here"), network && `${t("devicesPage.network.title")}: ${networkShort(network)}`, botsLabel(bots)].filter(Boolean).join(", ");
  return (
    <button type="button" data-map-node="here" aria-label={label} title={device.name} onClick={() => onOpen(device.id)}
      className={cn(NODE, "-m-1.5 w-[calc(100%+0.75rem)] max-w-none flex-wrap gap-x-3 gap-y-1 rounded-xl p-1.5")}>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center text-ink-secondary">{mark}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium leading-5 text-ink">{device.name}</span>
        <span className="text-[12px] leading-4 text-ink-tertiary">{t("devicesPage.status.here")}</span>
      </span>
      {network && <span data-map-network={network.state} className="flex shrink-0 items-center gap-1.5 rounded-full bg-ink/[0.05] px-2 py-0.5 text-[12px] leading-4 text-ink-secondary">
        <Waypoints size={12} aria-hidden="true" />{t("devicesPage.network.title")}<StatusMark status={networkMark(network)} />
      </span>}
      <BotFaces bots={bots} size={20} />
    </button>
  );
}

/** One device on the map: a status mark, its name cut short if it must be (the row below has it whole) and the bots on it.
 * Its edge is solid while it is reachable and dashed while it is away. */
function Node({ device, now, onOpen }: { device: Device; now: number; onOpen: (id: string) => void }) {
  const bots = useBotsOn(device);
  const mark = markOf(device);
  const label = [device.name, kindLabel(device.kind), statusText(device, now), routeOf(device), botsLabel(bots)].filter(Boolean).join(", ");
  return (
    <li className="min-w-0 max-w-full">
      <button type="button" data-map-node={device.id} data-map-line={device.status === "offline" ? "away" : "on"} aria-label={label} title={device.name}
        onClick={() => onOpen(device.id)} className={cn(NODE, "h-7 border ps-2.5 pe-2", LINE, device.status === "offline" && "border-dashed")}>
        {mark !== "unknown" && <StatusMark status={mark} />}
        <span className="min-w-0 truncate text-[13px] leading-[18px] text-ink">{device.name}</span>
        <BotFaces bots={bots} size={14} />
      </button>
    </li>
  );
}

/** A group hangs off the line from the hub: its own line down the side, solid while any of it is reachable. */
function Group({ group, devices, last, now, onOpen }: { group: DeviceGroup; devices: readonly Device[]; last: boolean; now: number; onOpen: (id: string) => void }) {
  const id = useId();
  const dashed = away(devices) && "border-dashed";
  return (
    <div data-map-group={group} className="relative min-w-0 ps-8 pt-3">
      {!last && <span aria-hidden="true" className={cn("absolute start-4 top-0 w-[calc(100%+1rem)] border-t", LINE)} />}
      <span aria-hidden="true" className={cn("absolute start-4 top-0 bottom-3.5 border-s", LINE, dashed)} />
      <span aria-hidden="true" className={cn("absolute start-4 top-[22px] w-3 border-t", LINE, dashed)} />
      <span id={id} className="block pb-2 text-[12px] font-medium leading-4 text-ink-secondary">{t(GROUP[group])}</span>
      <ul aria-labelledby={id} className="flex flex-wrap gap-1.5">
        {devices.map((device) => <Node key={device.id} device={device} now={now} onOpen={onOpen} />)}
      </ul>
    </div>
  );
}

/** The same picture in one line, for a window too narrow to draw it. */
export function mapSummary(devices: readonly Device[]): string {
  const groups = groupByKind(devices);
  if (groups.length === 0) return t("devicesPage.map.nothingYet");
  return groups.map(({ group, devices: some }) => t(COUNT[group][some.length === 1 ? 0 : 1], { count: some.length })).join(" · ");
}

/**
 * A compact picture at the top of Devices: this place as the hub with the private network on it, and every other device
 * as a small node in its group, joined by a line that is solid while it is reachable and dashed while it is away. It has
 * no actions of its own: a node opens that device's row below. In a narrow window it is one line of words.
 */
export function DeviceMap({ devices, mark, network, loaded, onOpen, now = Date.now() }: {
  devices: readonly Device[]; mark: ReactNode; network: PrivateNetwork | null;
  /** every source has answered: until then nothing is said about what isn't there */
  loaded: boolean;
  onOpen: (id: string) => void;
  now?: number;
}) {
  const here = devices.find((device) => device.here);
  if (!here) return null;
  const groups = groupByKind(devices);
  const everyoneAway = groups.length > 0 && groups.every((entry) => away(entry.devices));
  return (
    <div data-settings-block="map" role="group" aria-label={t("devicesPage.mapLabel")} className="@container/map">
      <div data-device-map="" className="settings-card relative flex flex-col rounded-[12px] bg-menu p-4 shadow-[inset_0_0_0_0.5px_var(--settings-edge)] @max-[519px]/map:hidden">
        <Hub device={here} mark={mark} network={network} onOpen={onOpen} />
        {groups.length > 0 && <>
          <span aria-hidden="true" className={cn("ms-4 mt-1.5 h-3 border-s", LINE, everyoneAway && "border-dashed")} />
          <div data-map-groups="" className="grid items-start gap-x-4" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}>
            {groups.map((entry, index) => <Group key={entry.group} group={entry.group} devices={entry.devices} last={index === groups.length - 1} now={now} onOpen={onOpen} />)}
          </div>
        </>}
        {groups.length === 0 && loaded && <p data-map-empty="" className="ps-11 pt-1 text-[13px] leading-[18px] text-ink-tertiary">{t("devicesPage.map.nothingYet")}</p>}
      </div>
      {loaded && <p data-map-summary="" className="hidden px-4 text-[13px] leading-[18px] text-ink-secondary @max-[519px]/map:block">{mapSummary(devices)}</p>}
    </div>
  );
}
