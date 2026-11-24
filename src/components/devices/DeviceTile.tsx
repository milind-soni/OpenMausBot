import { CircleAlert } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { Device, DeviceAction } from "@/lib/devices";
import { t } from "@/lib/i18n";
import { useStoreSelector } from "@/state/store-select";
import { actionLabel } from "./DeviceList";
import { KIND_ICON, kindLabel, routeLabel, statusText } from "./device-words";

const FACES = 3;

/** How a device is, at a glance: a mark and words, never the colour alone. */
export function StatusMark({ status }: { status: Device["status"] }) {
  if (status === "attention") return <CircleAlert size={14} aria-hidden="true" className="shrink-0 text-warning" />;
  if (status === "online") return <span aria-hidden="true" className="mx-[3px] size-2 shrink-0 rounded-full bg-success" />;
  if (status === "offline") return <span aria-hidden="true" className="mx-[3px] size-2 shrink-0 rounded-full border border-ink-tertiary" />;
  return null;
}

export function StatusLine({ device, now, className }: { device: Device; now: number; className?: string }) {
  const words = statusText(device, now);
  if (!words) return null;
  return (
    <span data-device-state={device.status} className={cn("flex min-w-0 items-center gap-1.5 text-[12px] leading-4", device.status === "attention" ? "text-ink" : "text-ink-secondary", className)}>
      <StatusMark status={device.status} />
      <span className="truncate">{words}</span>
    </span>
  );
}

/** The bots that work on a device, by name, for its label and its card. Bots this window does not know are left out. */
export function useBotsOn(device: Device) {
  const bots = useStoreSelector((state) => state.bots);
  return (device.bots ?? []).flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
}

/** Up to three faces, overlapping, then the rest as a count. */
export function BotFaces({ bots, size = 18, ring = "ring-(--color-menu)" }: { bots: ReturnType<typeof useBotsOn>; size?: number; ring?: string }) {
  if (bots.length === 0) return null;
  return (
    <span data-device-bots={bots.length} aria-hidden="true" className="flex shrink-0 items-center -space-x-1.5">
      {bots.slice(0, FACES).map((bot) => <span key={bot.id} className={cn("rounded-full ring-2", ring)}><BotAvatar bot={bot} size={size} /></span>)}
      {bots.length > FACES && <span className={cn("flex items-center justify-center rounded-full bg-raised px-1 text-[11px] leading-none text-ink-secondary tabular-nums ring-2", ring)}
        style={{ minWidth: size, height: size }}>+{bots.length - FACES}</span>}
    </span>
  );
}

export const botsLabel = (bots: ReturnType<typeof useBotsOn>) => (bots.length ? t("devicesPage.bots.on", { names: bots.map((bot) => bot.name).join(", ") }) : "");

/** The one thing a device needs, right on its tile, by what it needs. An update only copies a command, so its button
 * opens the card that says so. */
const TILE_ACTION: Partial<Record<NonNullable<Device["note"]>, DeviceAction["type"]>> = { update: "copy-update", "signed-out": "pair-again", insecure: "pair-again", unreachable: "retry" };
export const tileActionOf = (device: Device) => {
  const type = device.note && TILE_ACTION[device.note];
  return type ? device.actions.find((action) => action.type === type) : undefined;
};

/** One device on the map: what it is, how it is, how it connects and the bots on it. Choosing it opens its card. In a
 * narrow map the tile is one row, with how it connects and its bots at the end. */
export function DeviceTile({ device, selected, onSelect, onAction, now }: {
  device: Device; selected: boolean; onSelect: (id: string) => void; onAction: (device: Device, action: DeviceAction) => void; now: number;
}) {
  const Icon = KIND_ICON[device.kind];
  const bots = useBotsOn(device);
  const action = tileActionOf(device);
  const route = device.kind === "cloud" || device.kind === "vm" ? null : routeLabel(device.route);
  const line = statusText(device, now);
  const label = [device.name, kindLabel(device.kind), line, route, botsLabel(bots)].filter(Boolean).join(", ");
  const actionText = action && (action.type === "copy-update" ? t("devicesPage.tile.update") : actionLabel(action, device));
  return (
    <div className={cn("relative flex min-w-0 flex-col rounded-xl bg-menu transition-colors hover:bg-ink/[0.06] motion-reduce:transition-none",
      selected ? "shadow-[inset_0_0_0_1px_var(--color-ink)]" : "shadow-[inset_0_0_0_0.5px_var(--settings-edge)]")}>
      <button type="button" data-device-node={device.id} data-device-status={device.status} aria-expanded={selected} aria-controls={selected ? "device-card" : undefined}
        onClick={() => onSelect(device.id)} aria-label={label} title={device.name}
        className="flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl px-2.5 py-2.5 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus @max-[519px]/map:flex-row @max-[519px]/map:items-center @max-[519px]/map:gap-3">
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <Icon size={16} aria-hidden="true" className="mt-px shrink-0 text-ink-secondary" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-medium leading-[18px] text-ink">{device.name}</span>
            <StatusLine device={device} now={now} />
          </span>
        </span>
        {(route || bots.length > 0) && (
          <span className="flex min-h-5 min-w-0 items-center gap-2 ps-6 @max-[519px]/map:max-w-[45%] @max-[519px]/map:shrink-0 @max-[519px]/map:ps-0">
            {route && <span data-device-route-chip="" className="truncate text-[12px] leading-4 text-ink-tertiary">{route}</span>}
            <span className="ms-auto"><BotFaces bots={bots} /></span>
          </span>
        )}
      </button>
      {action && (
        <span className="flex px-2.5 pb-2.5 ps-[34px]">
          <button type="button" data-tile-action={action.type} onClick={() => (action.type !== "copy-update" ? onAction(device, action) : selected ? undefined : onSelect(device.id))}
            aria-label={`${actionText}: ${device.name}`} className="ui-button ui-button-sm max-w-full">{actionText}</button>
        </span>
      )}
    </div>
  );
}
