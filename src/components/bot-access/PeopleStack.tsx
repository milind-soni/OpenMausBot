import { cn } from "@/lib/cn";
import type { TeamPeople } from "@/state/team-people";
import { nameOf, personOf } from "./access";
import { EntryFace } from "./ShareControls";

const STACK_SHOWN = 4;

/** The faces of the people a bot is shared with, a few and then "+N". With `onOpen` each face is a button that says
 * that person's name and opens what the stack is about; without it the stack is one picture named for them all. */
export function PeopleStack({ entries, team, size = 22, shown = STACK_SHOWN, ring = "ring-card", overlap = "-space-x-0.5", onOpen }: {
  entries: string[]; team: Pick<TeamPeople, "people"> | null; size?: number; shown?: number; ring?: string; overlap?: string; onOpen?: () => void;
}) {
  if (!entries.length) return null;
  const names = (of: string[]) => of.map((entry) => nameOf(entry, team)).join(", ");
  const rest = entries.slice(shown);
  const more = cn("flex items-center justify-center rounded-full bg-card px-1 text-[11px] font-medium tabular-nums text-ink-secondary ring-2", ring);
  const box = { height: size, minWidth: size };
  if (!onOpen) {
    return (
      <span role="img" aria-label={names(entries)} title={names(entries)} data-access-stack={entries.length} className={cn("flex shrink-0 rtl:space-x-reverse", overlap)}>
        {entries.slice(0, shown).map((entry) => (
          <span key={entry} className={cn("flex rounded-full ring-2", ring)}><EntryFace person={personOf(entry, team)} size={size} /></span>
        ))}
        {rest.length > 0 && <span style={box} className={more}>+{rest.length}</span>}
      </span>
    );
  }
  const face = "rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <span role="group" aria-label={names(entries)} data-access-stack={entries.length} className={cn("flex shrink-0 rtl:space-x-reverse", overlap)}>
      {entries.slice(0, shown).map((entry) => (
        <button key={entry} type="button" aria-haspopup="dialog" data-access-face={entry} title={nameOf(entry, team)} aria-label={nameOf(entry, team)} onClick={onOpen}
          className={cn("flex ring-2", ring, face)}><EntryFace person={personOf(entry, team)} size={size} /></button>
      ))}
      {rest.length > 0 && <button type="button" aria-haspopup="dialog" data-access-more={rest.length} title={names(rest)} aria-label={names(rest)} onClick={onOpen}
        style={box} className={cn(more, face)}>+{rest.length}</button>}
    </span>
  );
}
