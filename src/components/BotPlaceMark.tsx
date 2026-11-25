// The small device mark after a bot's name in the one list: where the bot lives, shown on hover and keyboard focus, and
// shown at rest only while it says something (working, My Cloud asleep or waking, a place that can't be reached). A screen
// reader hears it on every row, shown or not. Nothing with the switch off.
import { Cloud, CloudMoon, CloudOff, Laptop, MonitorOff, Server, ServerOff, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PlaceIcon, PlaceMark } from "@/lib/place-rows";

const ICONS: Record<PlaceIcon, LucideIcon> = {
  computer: Laptop, cloud: Cloud, server: Server, "cloud-asleep": CloudMoon, "cloud-waking": Cloud, "cloud-off": CloudOff, "computer-off": MonitorOff, "server-off": ServerOff,
};
/** Asleep and can't-be-reached are drawn quieter than the rest, never in an alarm colour. */
const QUIET = new Set<PlaceIcon>(["cloud-asleep", "cloud-off", "computer-off", "server-off"]);

/** The avatars-only sidebar has no name to put the mark after: a row of the other place carries it as a small badge at
 * its avatar's bottom-left instead, always (as the old group's rows did), in its informative icon while there is one.
 * Rows of the other place have no model badge, which sits there for this page's own rows. */
export function BotPlaceBadge({ mark }: { mark: PlaceMark | null }) {
  if (!mark) return null;
  const Icon = ICONS[mark.icon];
  return (
    <span data-bot-place-badge={mark.icon} className="absolute -bottom-0.5 -left-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-panel bg-panel">
      <Icon size={12} strokeWidth={2} aria-hidden="true" className={cn("shrink-0", QUIET.has(mark.icon) ? "text-ink-tertiary" : "text-ink-secondary", mark.icon === "cloud-waking" && "animate-pulse motion-reduce:animate-none")} />
    </span>
  );
}

export function BotPlaceMark({ mark }: { mark: PlaceMark | null }) {
  if (!mark) return null;
  const Icon = ICONS[mark.icon];
  return (
    <Icon size={13} strokeWidth={2} role="img" aria-label={mark.label} data-bot-home={mark.place} data-bot-place-kind={mark.kind} data-bot-place={mark.icon} data-bot-place-shows={mark.shows}
      className={cn("shrink-0", mark.shows === "always"
        ? cn(QUIET.has(mark.icon) ? "text-ink-tertiary" : "text-ink-secondary", mark.icon === "cloud-waking" && "animate-pulse motion-reduce:animate-none")
        : "text-ink-secondary opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100")}>
      <title>{mark.label}</title>
    </Icon>
  );
}
