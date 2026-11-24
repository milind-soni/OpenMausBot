import { CircleAlert } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { Device, DeviceAction } from "@/lib/devices";
import { t } from "@/lib/i18n";
import { useStoreSelector } from "@/state/store-select";
import { kindLabel, routeLabel, statusText } from "./device-words";

const FACES = 3;

/** How a device is, at a glance: a mark and words, never the colour alone. */
export function StatusMark({ status }: { status: Device["status"] }) {
  if (status === "attention") return <CircleAlert size={14} aria-hidden="true" className="shrink-0 text-warning" />;
  if (status === "online") return <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />;
  if (status === "offline") return <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-ink-tertiary" />;
  return null;
}

/** How it connects, after its state: only a way that is open. A Cloud leaves it out, and a cloud desktop says what it is. */
export const routeOf = (device: Device): string | null => {
  if (device.here || device.kind === "cloud") return null;
  if (device.kind === "vm") return kindLabel("vm");
  return device.routes.includes(device.route) ? routeLabel(device.route) : null;
};

/** What the mark shows: a device that can't be reached or needs a step is marked as needing the person, even while away. */
export const markOf = (device: Device): Device["status"] => (device.note && device.note !== "reconnecting" ? "attention" : device.status);

/** "● Online · Same network": the state in a mark and words, then how it connects, in one line that wraps. */
export function StatusLine({ device, now, className }: { device: Device; now: number; className?: string }) {
  const words = statusText(device, now);
  const route = routeOf(device);
  if (!words && !route) return null;
  const mark = markOf(device);
  return (
    <span data-device-state={mark} className={cn("flex min-w-0 items-start gap-1.5 text-[13px] leading-[18px]", className)}>
      {mark !== "unknown" && <span className="flex h-[18px] w-3.5 shrink-0 items-center"><StatusMark status={mark} /></span>}
      <span className="min-w-0">
        {words && <span className={mark === "attention" ? "text-ink" : "text-ink-secondary"}>{words}</span>}
        {words && route && <span aria-hidden="true" className="text-ink-tertiary @max-[479px]/rows:hidden">{" · "}</span>}
        {route && <span data-device-route="" className="whitespace-nowrap text-ink-secondary @max-[479px]/rows:block">{route}</span>}
      </span>
    </span>
  );
}

/** The bots that work on a device, by name. Bots this window does not know are left out. */
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

/** The faces, then how many bots in words, so the faces never stand unexplained. */
export function BotsOn({ bots }: { bots: ReturnType<typeof useBotsOn> }) {
  if (bots.length === 0) return null;
  return <span className="flex shrink-0 items-center gap-1.5">
    <BotFaces bots={bots} />
    <span aria-hidden="true" className="text-[12px] leading-4 text-ink-tertiary tabular-nums">{t(bots.length === 1 ? "devicesPage.bots.oneUses" : "devicesPage.bots.countUse", { count: bots.length })}</span>
  </span>;
}

export const botsLabel = (bots: ReturnType<typeof useBotsOn>) => (bots.length ? t("devicesPage.bots.on", { names: bots.map((bot) => bot.name).join(", ") }) : "");

/** The one thing a device needs, on its row, by what it needs. An update is a command to run there, so its button opens
 * the details that show it. */
const NEED: Partial<Record<NonNullable<Device["note"]>, DeviceAction["type"]>> = {
  update: "copy-update", "signed-out": "pair-again", insecure: "pair-again", unreachable: "retry", "no-way-in": "turn-on-way",
};
export const needOf = (device: Device) => {
  const type = device.note && NEED[device.note];
  return type ? device.actions.find((action) => action.type === type) : undefined;
};
