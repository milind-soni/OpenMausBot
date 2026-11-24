import { Plus } from "lucide-react";
import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { groupByKind, type Device, type DeviceAction, type DeviceGroup, type PrivateNetwork } from "@/lib/devices";
import { BotFaces, botsLabel, StatusMark, useBotsOn } from "./DeviceTile";
import { DeviceTile } from "./DeviceTile";
import { groupLabel, networkShort, statusText } from "./device-words";

/** Under this width the groups stack under one trunk and every tile is a full-width row. */
export const NARROW_MAP_PX = 520;

const SOLID = "border-ink-secondary/35";
const AWAY = "border-dashed border-ink-secondary/35";
const away = (devices: readonly Device[]) => devices.every((device) => device.status === "offline");

export interface NetworkAction {
  label: string;
  run?: () => void;
  href?: string;
  busy?: boolean;
}

const NETWORK_MARK: Partial<Record<PrivateNetwork["state"], Device["status"]>> = { ready: "online", unknown: "unknown" };

/** The private network on this computer: its state in a few words, the whole next step under it, and one button. */
function NetworkRow({ network, line, action, secondary }: { network: PrivateNetwork; line: string; action: NetworkAction | null; secondary?: ReactNode }) {
  return (
    <div data-settings-block="network" data-private-network="" className="flex scroll-mt-4 flex-wrap items-center gap-x-3 gap-y-2 border-t-[0.5px] border-(--settings-edge) px-3 py-2.5">
      <div className="flex min-w-[min(100%,14rem)] flex-1 flex-col gap-0.5 ps-12">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] leading-[18px] text-ink">
          <span>{t("devicesPage.network.title")}<span className="text-ink-tertiary">{" · Tailscale"}</span></span>
          <span data-network-state={network.state} className={cn("flex items-center gap-1.5 text-[12px] leading-4", network.state === "ready" || network.state === "unknown" ? "text-ink-secondary" : "text-ink")}>
            <StatusMark status={NETWORK_MARK[network.state] ?? "attention"} />{networkShort(network)}
          </span>
        </span>
        <span data-network-line={network.state} aria-live="polite" className="text-[12px] leading-4 text-ink-tertiary">{line}</span>
      </div>
      {(action || secondary) && (
        <span className="flex shrink-0 items-center gap-2 ps-12 @min-[520px]/map:ps-0">
          {secondary}
          {action && (action.href
            ? <a href={action.href} target="_blank" rel="noreferrer" className="ui-button ui-button-sm" data-network-action="">{action.label}</a>
            : <button type="button" className="ui-button ui-button-sm" data-network-action="" disabled={action.busy} onClick={action.run}>{action.label}</button>)}
        </span>
      )}
    </div>
  );
}

/** This place, the hub every line starts from: its mark, the bots on it, Add a device, and on This computer the private network. */
function Hub({ device, mark, selected, onSelect, onAdd, network }: {
  device: Device; mark: ReactNode; selected: boolean; onSelect: (id: string) => void; onAdd: () => void; network: ReactNode;
}) {
  const bots = useBotsOn(device);
  return (
    <div data-device-hub="" className={cn("flex flex-col rounded-xl bg-menu", selected ? "shadow-[inset_0_0_0_1px_var(--color-ink)]" : "shadow-[inset_0_0_0_0.5px_var(--settings-edge)]")}>
      <div className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-3">
        <button type="button" data-device-node="here" aria-expanded={selected} aria-controls={selected ? "device-card" : undefined} onClick={() => onSelect(device.id)} title={device.name}
          aria-label={[device.name, statusText(device), botsLabel(bots)].filter(Boolean).join(", ")}
          className="-m-1.5 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg p-1.5 text-start transition-colors hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
          <span className="flex size-9 shrink-0 items-center justify-center text-ink-secondary">{mark}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-medium leading-5 text-ink">{device.name}</span>
            <span className="truncate text-[12px] leading-4 text-ink-secondary">{statusText(device)}</span>
          </span>
          <span className="ms-auto"><BotFaces bots={bots} size={22} /></span>
        </button>
        <button type="button" data-settings-block="add" data-add-device="" onClick={onAdd} className="ui-button ui-button-primary inline-flex shrink-0 scroll-mt-4 items-center gap-1.5">
          <Plus size={14} aria-hidden="true" />{t("devicesPage.add")}
        </button>
      </div>
      {network}
    </div>
  );
}

/** The line from the group's trunk to one tile: solid while it is reachable, dashed while it is away, moving while it is connected now. */
function Stub({ device, last }: { device: Device; last: boolean }) {
  const gone = device.status === "offline";
  return <>
    <span aria-hidden="true" className={cn("absolute start-2 top-0 border-s", last ? "h-5" : "-bottom-2", SOLID)} />
    <span aria-hidden="true" data-line={device.live ? "live" : gone ? "away" : "on"} className={cn("absolute start-2 top-5 w-3 border-t", gone ? AWAY : SOLID)} />
    {device.live && (
      <svg aria-hidden="true" viewBox="0 0 12 2" className="absolute start-2 top-5 -mt-px h-0.5 w-3 overflow-visible rtl:-scale-x-100">
        <line x1="0" y1="1" x2="12" y2="1" strokeWidth="1.5" strokeDasharray="2 3" className="animate-link-flow stroke-success" style={{ animationDuration: "2.2s" }} />
      </svg>
    )}
  </>;
}

function Group({ group, devices, last, selected, onSelect, onAction, panel, now }: {
  group: DeviceGroup; devices: readonly Device[]; last: boolean; selected: string | null; onSelect: (id: string) => void;
  onAction: (device: Device, action: DeviceAction) => void; panel: ReactNode; now: number;
}) {
  const id = useId();
  const line = away(devices) ? AWAY : SOLID;
  return (
    <section data-device-group={group} aria-labelledby={id} className="relative row-span-2 grid min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-subgrid @max-[519px]/map:pb-3">
      {!last && <span aria-hidden="true" className={cn("absolute start-2 top-0 w-[calc(100%+1rem)] border-t @max-[519px]/map:hidden", line)} />}
      {!last && <span aria-hidden="true" className={cn("absolute start-2 top-0 bottom-0 hidden border-s @max-[519px]/map:block", SOLID)} />}
      <h3 id={id} className="relative min-w-0 ps-5 pt-3 pb-2 text-[12px] font-medium leading-4 text-ink-secondary">
        <span aria-hidden="true" className={cn("absolute start-2 top-0 bottom-0 border-s", line)} />
        {groupLabel(group)}
      </h3>
      <ul className="flex min-w-0 flex-col gap-2 self-start">
        {devices.map((device, index) => (
          <Fragment key={device.id}>
            <li className="relative min-w-0 ps-5">
              <Stub device={device} last={index === devices.length - 1 && !(panel && selected === device.id)} />
              <DeviceTile device={device} selected={selected === device.id} onSelect={onSelect} onAction={onAction} now={now} />
            </li>
            {panel && selected === device.id && <li className="relative min-w-0 ps-5 pt-1">
              {index < devices.length - 1 && <span aria-hidden="true" className={cn("absolute start-2 top-0 -bottom-2 border-s", SOLID)} />}
              {panel}
            </li>}
          </Fragment>
        ))}
      </ul>
    </section>
  );
}

/** The map's width, for where the chosen device's card goes and where its pointer sits. */
function useMapLayout(root: React.RefObject<HTMLElement | null>, selected: string | null) {
  const [width, setWidth] = useState(0);
  const [caret, setCaret] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useLayoutEffect(() => {
    const element = root.current;
    const tile = selected ? element?.querySelector(`[data-device-node="${CSS.escape(selected === "here" ? "here" : selected)}"]`) : null;
    const card = element?.querySelector("[data-device-card]");
    if (!tile || !card) { setCaret(null); return; }
    const at = tile.getBoundingClientRect(), box = card.getBoundingClientRect();
    const rtl = getComputedStyle(card).direction === "rtl";
    setCaret(Math.round(Math.max(16, Math.min(box.width - 16, rtl ? box.right - (at.right - 28) : at.left + 28 - box.left))));
  });
  return { narrow: width > 0 && width < NARROW_MAP_PX, caret };
}

/**
 * The map: this place as the hub, with a line down to a few plainly named groups (phones, computers, Clouds and your
 * own servers), each device a tile that says how it is, how it connects and which bots work on it. The chosen device's
 * card opens against the map: under the hub, under the groups (pointing at the tile), or in a narrow window right under
 * the tile. The groups are headed lists of buttons, so the map reads the same to a screen reader and the keyboard.
 */
export function DeviceMap({ devices, mark, network, selected, onSelect, onClose, onAction, onAdd, panel, now = Date.now() }: {
  devices: readonly Device[];
  mark: ReactNode;
  network: { network: PrivateNetwork; line: string; action: NetworkAction | null; secondary?: ReactNode } | null;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Escape anywhere on the map while a device is chosen closes its card, never all of Settings. */
  onClose: () => void;
  onAction: (device: Device, action: DeviceAction) => void;
  onAdd: () => void;
  /** The chosen device's card, given where its pointer sits. */
  panel: (caret: number | null) => ReactNode;
  now?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { narrow, caret } = useMapLayout(root, selected);
  const here = devices.find((device) => device.here)!;
  const groups = groupByKind(devices);
  const card = selected ? panel(caret) : null;
  const inGroups = Boolean(card) && selected !== here.id;
  const everyoneAway = groups.every((entry) => away(entry.devices));
  return (
    <div ref={root} data-settings-block="map" data-map-layout={narrow ? "narrow" : "wide"} className="@container/map flex scroll-mt-4 flex-col" role="group" aria-label={t("devicesPage.mapLabel")}
      onKeyDown={(event) => { if (selected && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <Hub device={here} mark={mark} selected={selected === here.id} onSelect={onSelect} onAdd={onAdd}
        network={network && <NetworkRow {...network} />} />
      {selected === here.id && card && <div className="pt-3">{card}</div>}
      {groups.length > 0 ? <>
        <span aria-hidden="true" className={cn("ms-2 h-3 border-s", everyoneAway ? AWAY : SOLID)} />
        <div data-device-tree="" className="grid gap-x-4 @max-[519px]/map:grid-cols-1" style={narrow ? undefined : { gridTemplateColumns: `repeat(${Math.max(groups.length, 2)}, minmax(0, 1fr))` }}>
          {groups.map((entry, index) => (
            <Group key={entry.group} group={entry.group} devices={entry.devices} last={index === groups.length - 1} selected={selected}
              onSelect={onSelect} onAction={onAction} panel={narrow && inGroups ? card : null} now={now} />
          ))}
        </div>
        {!narrow && inGroups && <div className="pt-4">{card}</div>}
      </> : (
        <div className="relative ps-5 pt-3">
          <span aria-hidden="true" className={cn("absolute start-2 top-0 h-[34px] border-s", AWAY)} />
          <span aria-hidden="true" className={cn("absolute start-2 top-[34px] w-3 border-t", AWAY)} />
          <p data-devices-empty="" className="rounded-xl border border-dashed border-(--settings-edge) px-3 py-3 text-[13px] leading-[18px] text-ink-secondary">{t("devicesPage.empty")}</p>
        </div>
      )}
    </div>
  );
}
