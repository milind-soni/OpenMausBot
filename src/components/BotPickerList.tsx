import { Check } from "lucide-react";
import type { Bot } from "@/state/store";
import { teamBotName, useTeamPeople } from "@/state/team-people";
import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

export function BotPickerList({
  bots,
  picked,
  onToggle,
  emptyHint,
}: {
  bots: Bot[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  emptyHint: string;
}) {
  const team = useTeamPeople();
  return (
    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
      {bots.length === 0 && <div className="px-2 py-4 text-center text-[13px] text-ink-secondary">{emptyHint}</div>}
      {bots.map((b) => (
        <button
          key={b.id}
          onClick={() => onToggle(b.id)}
          role="checkbox"
          aria-label={teamBotName(b, team)}
          aria-checked={picked.has(b.id)}
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
        >
          <BotAvatar bot={b} state="happy" size={28} animated={false} />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{teamBotName(b, team)}</span>
          <span
            className={cn(
              "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
              picked.has(b.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
            )}
          >
            {picked.has(b.id) && <Check size={12} />}
          </span>
        </button>
      ))}
    </div>
  );
}
