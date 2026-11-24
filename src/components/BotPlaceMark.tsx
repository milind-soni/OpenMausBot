// The small device mark beside a bot's name in the one list: where it lives, shown on hover, and where it is working,
// asleep or waiting, shown while that is true. Design preview only (unified-sidebar-preview.html).
import { useState } from "react";
import { Cloud, CloudMoon, CloudOff, Laptop, Monitor, MonitorOff, Server, type LucideIcon } from "lucide-react";
import { placeMark, useBotPlaces, useBotWhere, usePlaceMarkVariant, type PlaceIcon } from "@/lib/bot-place";
import { cn } from "@/lib/cn";
import { OwnBotHomeMark } from "./OtherPlaceBots";

const ICONS: Record<PlaceIcon, LucideIcon> = {
  laptop: Laptop, desktop: Monitor, server: Server, cloud: Cloud, "cloud-asleep": CloudMoon, "cloud-waking": Cloud, "cloud-off": CloudOff, "computer-off": MonitorOff,
};
/** Asleep and off are normal states, drawn quieter than working, never in an alarm colour. */
const QUIET = new Set<PlaceIcon>(["cloud-asleep", "cloud-off", "computer-off"]);

export function BotPlaceMark({ bot }: { bot: { id: string; name: string } }) {
  const where = useBotWhere(bot.id);
  const variant = usePlaceMarkVariant();
  if (!where) return <OwnBotHomeMark />;
  const mark = placeMark(bot, where);
  const Icon = ICONS[mark.icon];
  return (
    <Icon size={13} strokeWidth={2} role="img" aria-label={mark.label} data-bot-place={mark.icon} data-bot-place-shows={mark.shows}
      className={cn("shrink-0 transition-opacity duration-150 motion-reduce:transition-none",
        mark.shows === "always" ? cn(QUIET.has(mark.icon) ? "text-ink-tertiary" : "text-ink-secondary", mark.icon === "cloud-waking" && "animate-pulse motion-reduce:animate-none")
          : variant === "faint" ? "text-ink-secondary opacity-40 group-hover:opacity-100 group-focus-within:opacity-100"
            : "text-ink-secondary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
      <title>{mark.label}</title>
    </Icon>
  );
}

/** The ＋'s New bot with the one list on: a single item, and where the bot will live as two small icons at its end. The
 * default is My Cloud; a click on the other icon changes it, and the choice is remembered for the next bot. */
export function NewBotWhere() {
  const on = useBotPlaces();
  const [where, setWhere] = useState<"cloud" | "computer">("cloud");
  if (!on) return null;
  const choice = (value: "cloud" | "computer", Icon: LucideIcon, label: string) => (
    <span role="radio" aria-checked={where === value} aria-label={label} title={label} tabIndex={where === value ? 0 : -1}
      onClick={(event) => { event.stopPropagation(); setWhere(value); }}
      className={cn("flex size-6 items-center justify-center rounded-md transition-colors", where === value ? "bg-raised text-ink" : "text-ink-tertiary hover:text-ink-secondary")}>
      <Icon size={14} aria-hidden="true" />
    </span>
  );
  return (
    <span role="radiogroup" aria-label="Where it lives" data-new-bot-where={where} className="ms-auto flex items-center gap-0.5 rounded-lg bg-inset/60 p-0.5">
      {choice("cloud", Cloud, "Lives on My Cloud")}
      {choice("computer", Laptop, "Lives on this computer")}
    </span>
  );
}
