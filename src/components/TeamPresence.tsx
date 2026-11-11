// Who is here on a team: the dot on a teammate's face, and the faces of the others who have a shared chat or a group
// chat open, at the right of its header. Nothing in a private chat, and nothing at all against a server that sends no
// presence.
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { useThreadPresence } from "@/state/team-presence";
import { PersonFace } from "./TeamOwner";

/** On a face of `size`: this person is here now. `edge` is the surface behind it, so the dot reads as cut out of it. */
export function HereDot({ size, edge = "panel" }: { size: number; edge?: "panel" | "app" }) {
  const dot = Math.max(7, Math.round(size * 0.3));
  return <span aria-hidden="true" data-here-dot style={{ width: dot, height: dot }}
    className={cn("absolute -bottom-px -right-px rounded-full bg-success ring-2", edge === "app" ? "ring-app" : "ring-panel")} />;
}

const FACES = 3;
const FACE = 24;
const names = (people: ReadonlyArray<{ name: string }>) => new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(people.map((person) => person.name));

/** At the right of a shared conversation's header: the faces of the others who have it open now. */
export function ThreadPresenceFaces({ threadId }: { threadId: string }) {
  const { here } = useThreadPresence(threadId);
  if (here.length === 0) return null;
  const label = t(here.length === 1 ? "presence.hasOpen" : "presence.haveOpen", { names: names(here) });
  const more = here.length - FACES;
  return (
    <span role="img" aria-label={label} title={label} data-thread-presence={here.length} className="flex shrink-0 items-center -space-x-1.5">
      {here.slice(0, FACES).map((person) => (
        <span key={person.email} className="relative inline-flex rounded-full ring-2 ring-app"><PersonFace person={person} size={FACE} /><HereDot size={FACE} edge="app" /></span>
      ))}
      {more > 0 && (
        <span className="relative flex h-6 min-w-6 items-center justify-center rounded-full border border-app bg-raised px-1 text-[11px] font-medium tabular-nums text-ink-secondary">+{more}</span>
      )}
    </span>
  );
}
