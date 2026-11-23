import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { groupByRoute, type Device, type DeviceRoute, type PrivateNetwork } from "@/lib/devices";
import { DOT, KIND_ICON, kindLabel, networkShort, routeLabel, statusText } from "./device-words";

const NODE = "relative flex w-48 min-w-0 cursor-pointer items-center gap-3 rounded-xl bg-menu px-3 py-2 text-start transition-colors hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-safe:animate-fade-in @max-[480px]/map:w-full";

/** One device on the map: its mark with a status dot, its name and one line. Choosing it opens its row below. */
export function DeviceNode({ device, selected, onSelect, now }: { device: Device; selected: boolean; onSelect: (id: string) => void; now: number }) {
  const Icon = KIND_ICON[device.kind];
  const dot = DOT[device.status];
  const line = statusText(device, now);
  return (
    <button type="button" data-device-node={device.id} data-device-status={device.status} aria-pressed={selected} onClick={() => onSelect(device.id)}
      aria-label={`${device.name}, ${kindLabel(device.kind)}, ${line}`} title={device.name}
      className={cn(NODE, selected ? "shadow-[inset_0_0_0_1px_var(--color-ink)]" : "shadow-[inset_0_0_0_0.5px_var(--settings-edge)]")}>
      <span className="relative flex size-5 shrink-0 items-center justify-center text-ink-secondary">
        <Icon size={16} aria-hidden="true" />
        {dot && <span aria-hidden="true" className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-(--color-menu)", dot)} />}
      </span>
      <span className="flex w-full min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium leading-[18px] text-ink">{device.name}</span>
        <span className={cn("truncate text-[12px] leading-4", device.status === "attention" ? "text-warning" : "text-ink-secondary")}>{line}</span>
      </span>
    </button>
  );
}

/** The root of the map: the place whose Settings these are, with the same mark as the rail and the nav. */
export function HereNode({ device, mark, selected, onSelect }: { device: Device; mark: ReactNode; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button type="button" data-device-node="here" aria-pressed={selected} onClick={() => onSelect(device.id)} title={device.name}
      aria-label={`${device.name}, ${statusText(device)}`}
      className={cn("flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-xl bg-menu px-3 py-2 text-start transition-colors hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        selected ? "shadow-[inset_0_0_0_1px_var(--color-ink)]" : "shadow-[inset_0_0_0_0.5px_var(--settings-edge)]")}>
      <span className="flex size-8 shrink-0 items-center justify-center text-ink-secondary">{mark}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[14px] font-medium leading-5 text-ink">{device.name}</span>
        <span className="truncate text-[12px] leading-4 text-ink-secondary">{statusText(device)}</span>
      </span>
    </button>
  );
}

/** A route's branch off the trunk: its name where the line meets it, then its devices. Dashed while none is online. */
function Branch({ route, last, quiet, label, aside, children, boxed }: { route: DeviceRoute; last: boolean; quiet: boolean; label: ReactNode; aside?: ReactNode; children: ReactNode; boxed?: boolean }) {
  // The stub meets the group's first row: the private network's header, or a plain group's devices (its name sits
  // beside them when the map is wide, above them when it is narrow).
  const stub = boxed ? "top-6" : "top-2 @min-[560px]/map:top-6";
  return (
    <li data-device-route={route} className="relative pb-3 ps-6">
      <span aria-hidden="true" className={cn("absolute start-0 top-0 w-0 border-s border-hairline", last ? (boxed ? "h-6" : "h-2 @min-[560px]/map:h-6") : "h-full", quiet && "border-dashed")} />
      <span aria-hidden="true" className={cn("absolute start-0 w-5 border-t border-hairline", stub, quiet && "border-dashed")} />
      {boxed ? (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-hairline px-3 py-3" data-private-network="">
          <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-[12px] font-medium leading-4 text-ink-secondary">{label}</span>
            {aside}
          </div>
          {children}
        </div>
      ) : (
        <div className="flex flex-col gap-2 @min-[560px]/map:flex-row @min-[560px]/map:items-start">
          <span className="text-[12px] font-medium leading-4 text-ink-secondary @min-[560px]/map:mt-4 @min-[560px]/map:w-28 @min-[560px]/map:shrink-0">{label}</span>
          {children}
        </div>
      )}
    </li>
  );
}

export interface NetworkAction {
  label: string;
  run?: () => void;
  href?: string;
  busy?: boolean;
}

/**
 * The map: this place at the root, a trunk down its left, and one branch per way devices reach it, named where the line
 * meets it. The private network (Tailscale) is a dashed group of its own, always drawn on This computer, with its state
 * and the one next step. In a narrow window every device becomes a full-width row: the same tree, read as a list.
 */
export function DeviceMap({ devices, network, networkAction, selected, onSelect, onAdd, here, now = Date.now() }: {
  devices: readonly Device[];
  network: PrivateNetwork | null;
  networkAction: NetworkAction | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  here: ReactNode;
  now?: number;
}) {
  const groups = groupByRoute(devices);
  const shown = network && !groups.some((group) => group.route === "tailscale") ? [{ route: "tailscale" as const, devices: [] as Device[] }, ...groups] : groups;
  const alone = groups.length === 0;
  const action = networkAction && (networkAction.href
    ? <a href={networkAction.href} target="_blank" rel="noreferrer" className="ui-button ui-button-sm" data-network-action="">{networkAction.label}</a>
    : <button type="button" className="ui-button ui-button-sm" data-network-action="" disabled={networkAction.busy} onClick={networkAction.run}>{networkAction.label}</button>);
  return (
    <div data-settings-block="map" className="@container/map flex scroll-mt-4 flex-col" role="group" aria-label={t("devicesPage.mapLabel")}>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
        {here}
        <button type="button" data-settings-block="add" data-add-device="" onClick={onAdd} className="ui-button ui-button-primary inline-flex scroll-mt-4 items-center gap-1.5">
          <Plus size={14} aria-hidden="true" />{t("devicesPage.add")}
        </button>
      </div>
      {shown.length > 0 && (
        <ul className="ms-4 flex flex-col" data-device-tree="">
          {shown.map((group, index) => {
            const quiet = group.devices.every((device) => device.status !== "online");
            const isNetwork = group.route === "tailscale" && network;
            return (
              <Branch key={group.route} route={group.route} last={index === shown.length - 1} quiet={quiet} boxed={Boolean(isNetwork)}
                label={isNetwork ? <>{t("devicesPage.network.title")}<span className="font-normal text-ink-tertiary">{" · Tailscale"}</span></> : routeLabel(group.route)}
                aside={isNetwork ? <span className="flex items-center gap-2">
                  <span data-network-state={network.state} className={cn("text-[12px] leading-4", network.state === "ready" ? "text-ink-secondary" : network.state === "unknown" ? "text-ink-tertiary" : "text-warning")}>{networkShort(network)}</span>
                  {action}
                </span> : undefined}>
                {group.devices.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {group.devices.map((device) => <DeviceNode key={device.id} device={device} selected={selected === device.id} onSelect={onSelect} now={now} />)}
                  </div>
                )}
              </Branch>
            );
          })}
        </ul>
      )}
      {alone && <p data-devices-empty="" className="ps-4 pt-1 text-[13px] leading-[18px] text-ink-secondary">{t("devicesPage.empty")}</p>}
    </div>
  );
}
