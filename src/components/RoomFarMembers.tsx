import { Check } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Group } from "@/state/store";

type FarMember = NonNullable<Group["farMembers"]>[number];

/** The members of a room that live in another of the person's places, still members of it. */
export function farMembersOf(group: Pick<Group, "memberIds" | "farMembers">): FarMember[] {
  return (group.farMembers ?? []).filter((member) => group.memberIds.includes(member.id));
}

/**
 * Those members in the room's member list: each with where it lives, and why it cannot answer now when it cannot (the
 * link is off, or its place no longer has it). It stays a member until the person unticks it here.
 */
export function RoomFarMembers({ members, picked, onToggle }: { members: FarMember[]; picked: Set<string>; onToggle: (id: string) => void }) {
  if (!members.length) return null;
  return (
    <div data-testid="room-far-members" className="mt-0.5 flex flex-col gap-0.5">
      {members.map((member) => {
        const why = member.state === "off" ? t("room.members.far.off") : member.state === "missing" ? t("room.members.far.missing") : "";
        const where = [member.place ? t("room.members.far.place", { place: member.place }) : "", why].filter(Boolean).join(" · ");
        return (
          <button
            key={member.id}
            onClick={() => onToggle(member.id)}
            role="checkbox"
            aria-label={where ? `${member.name}, ${where}` : member.name}
            aria-checked={picked.has(member.id)}
            data-far-member={member.id}
            data-far-state={member.state}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
          >
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[14px]", member.state === "ok" ? "text-ink" : "text-ink-secondary")}>{member.name}</span>
              {where && <span className="block truncate text-[12px] text-ink-secondary">{where}</span>}
            </span>
            <span
              className={cn(
                "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                picked.has(member.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
              )}
            >
              {picked.has(member.id) && <Check size={12} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
