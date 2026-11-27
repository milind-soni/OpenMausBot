import { useState, type DragEvent } from "react";
import { Hourglass } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { resetTime, type ResetMarker } from "@/lib/limit-resets";

export const BOT_DRAG_TYPE = "application/x-openmaus-bot";
export const EVENT_DRAG_TYPE = "application/x-openmaus-calendar-event";

/** What was dropped on a reset marker: a bot from the sidebar, or an automation already on the calendar. */
export type ResetDrop = { botId: string } | { event: { kind: "routine" | "call"; id: string; at: number } };

const accepts = (event: DragEvent) => event.dataTransfer.types.includes(BOT_DRAG_TYPE) || event.dataTransfer.types.includes(EVENT_DRAG_TYPE);

function dropped(event: DragEvent): ResetDrop | null {
  const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
  if (botId) return { botId };
  try {
    const item = JSON.parse(event.dataTransfer.getData(EVENT_DRAG_TYPE)) as { kind?: unknown; id?: unknown; at?: unknown };
    return (item.kind === "routine" || item.kind === "call") && typeof item.id === "string" && typeof item.at === "number"
      ? { event: { kind: item.kind, id: item.id, at: item.at } } : null;
  } catch {
    return null;
  }
}

/** "Claude resets 3:40 PM" across the day at the reset. Dropping a bot or an automation here makes it run when that
 * limit resets, instead of at a fixed time. */
export function LimitResetMarker({ marker, hourHeight, onDrop }: { marker: ResetMarker; hourHeight: number; onDrop?: (drop: ResetDrop) => void }) {
  const [over, setOver] = useState(false);
  const date = new Date(marker.at);
  const label = t("limits.marker", { engine: marker.name, time: resetTime(marker.at, marker.at) });
  return (
    <div data-limit-marker={marker.engine} role="note" aria-label={label} title={t("limits.markerDrop", { engine: marker.name })}
      className="absolute inset-x-0 z-[25] -translate-y-1/2 py-1.5"
      style={{ top: ((date.getHours() * 60 + date.getMinutes()) / 60) * hourHeight }}
      onPointerDown={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        if (!onDrop || !accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const drop = dropped(event);
        if (drop) onDrop?.(drop);
      }}>
      <div className={cn("h-0 border-t-2 border-dashed", over ? "border-accent" : "border-warning/80")} />
      <span className={cn("absolute left-1 top-0 flex max-w-[calc(100%-8px)] items-center gap-1 truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium shadow-sm",
        over ? "border-accent bg-accent text-accent-ink" : "border-warning/50 bg-panel text-ink")}>
        <Hourglass size={10} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}
