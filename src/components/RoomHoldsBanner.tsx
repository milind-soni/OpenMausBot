import { Pause } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStore, type Bot, type Group } from "@/state/store";

export function RoomHoldsBanner({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const held = members.filter((member) => group.holds?.[member.id]);
  if (!held.length) return null;
  return (
    <div className="w-full px-5">
      <div data-testid="room-holds" className="mb-1 flex flex-wrap items-center gap-1.5 px-2 text-[12px] text-ink-secondary">
        <Pause size={12} aria-hidden="true" />
        <span>{t("room.holds.banner", { names: held.map((member) => member.name).join(", ") })}</span>
        {held.map((member) => (
          <button
            key={member.id}
            type="button"
            onClick={() => dispatch({ type: "setGroupHold", groupId: group.id, botId: member.id, held: false })}
            className="cursor-pointer text-accent hover:underline"
          >
            {t("room.holds.resume", { name: member.name })}
          </button>
        ))}
      </div>
    </div>
  );
}
