// The end of the one list, while "This computer and My Cloud together" is on: the other place's bots are rows among this
// place's own (src/lib/place-rows.ts), so this says something only when that place has no rows to show: My Cloud not
// signed in to yet, or a place that is asleep or can't be reached with nothing kept from before. One quiet line in the
// list's secondary text, not a card or a banner; it opens My Cloud where there is something to do there. Nothing while
// the first read is under way, nothing with the switch off, and nothing on My Cloud's page, which lists its own bots only.
import { Cloud, CloudMoon, CloudOff, MonitorOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { oneListOn } from "@/lib/place-rows";
import { usePlacesTogetherPart, type PlacesTogetherState } from "@/lib/places-together";
import type { LocaleKey } from "@/locales";

type Said = "cloud:signin" | "cloud:asleep" | "cloud:waking" | "cloud:offline" | "computer:offline";

const SAID: Record<Said, { icon: typeof Cloud; words: LocaleKey; opens?: true }> = {
  "cloud:signin": { icon: Cloud, words: "together.state.signin", opens: true },
  "cloud:asleep": { icon: CloudMoon, words: "together.line.asleep", opens: true },
  "cloud:waking": { icon: Cloud, words: "together.state.waking" },
  "cloud:offline": { icon: CloudOff, words: "together.state.offlineCloud", opens: true },
  "computer:offline": { icon: MonitorOff, words: "together.state.offlineComputer" },
};

function saidOf(state: PlacesTogetherState | null): Said | null {
  const other = oneListOn(state) ? state!.other : null;
  if (!other || other.bots.length) return null;
  const said = `${other.home}:${other.state}`;
  return said in SAID ? said as Said : null;
}

/** My Cloud's page, opened from this computer's page (main's own switch, which wakes it as opening it always does). */
const openMyCloud = () => (window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudSendPage?.openMyCloud);

/** `icons`: the avatars-only sidebar, where the line is its icon alone, its words its tooltip and label. */
export function OtherPlaceLine({ query = "", icons = false }: { query?: string; icons?: boolean }) {
  const said = usePlacesTogetherPart(saidOf);
  if (!said || query.trim()) return null;
  const { icon: Icon, words, opens } = SAID[said];
  const open = opens ? openMyCloud() : undefined;
  const [home, state] = said.split(":");
  const line = t(words);
  const body = <><Icon size={icons ? 16 : 13} aria-hidden="true" className={cn("shrink-0", said === "cloud:waking" && "animate-pulse motion-reduce:animate-none")} />{icons ? null : <span className="min-w-0">{line}</span>}</>;
  const look = icons ? "flex size-9 items-center justify-center self-center text-ink-secondary" : "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] leading-4 text-ink-secondary";
  const named = icons ? { title: line, "aria-label": line } : {};
  return <div data-other-place={home} data-other-place-state={state} className={cn("flex flex-col", icons ? "pt-2" : "px-2 pb-1 pt-2")}>
    {open
      ? <button type="button" data-other-place-line="" {...named} onClick={() => { void open().catch(() => {}); }} className={cn(look, "rounded-lg hover:bg-menu-hover hover:text-ink")}>{body}</button>
      : <p role="status" data-other-place-line="" {...named} className={look}>{body}</p>}
  </div>;
}
