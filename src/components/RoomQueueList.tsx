import { t } from "@/lib/i18n";
import { busyPlaceOf, roomQueueLabel, roomThreadQueue } from "@/lib/room-threads";
import type { RoomQueueEntry } from "../../shared/wire";
import { useStore, type Bot, type Group, type Message } from "@/state/store";

const nameIn = (members: Bot[]) => (botId: string) => members.find((member) => member.id === botId)?.name;

export function RoomQueueList({ group, members }: { group: Group; members: Bot[] }) {
  const { state } = useStore();
  const queued = roomThreadQueue(group, group.threadId);
  if (!queued.length) return null;
  const nameOf = nameIn(members), placeOf = busyPlaceOf(state.groups, state.bots);
  return (
    <ul data-testid="room-queue" className="flex flex-col gap-0.5 pl-12 text-[13px] text-ink-secondary">
      {queued.map((entry) => (
        <li key={`${entry.botId}:${entry.position}`}>
          {t("room.queue.member", { name: nameOf(entry.botId) ?? t("sidebar.preview.aBot"), status: roomQueueLabel(entry, nameOf, placeOf) })}
        </li>
      ))}
    </ul>
  );
}

export function roomMemberQueueTitle(group: Group, members: Bot[], bot: Bot, placeOf?: (entry: RoomQueueEntry) => string | undefined): string | undefined {
  const entry = roomThreadQueue(group, group.threadId).find((candidate) => candidate.botId === bot.id);
  return entry ? t("room.queue.member", { name: bot.name, status: roomQueueLabel(entry, nameIn(members), placeOf) }) : undefined;
}

const ROUTED_BY = {
  jev: "room.routedBy", openrouter: "room.routedBy.openrouter", workersai: "room.routedBy.workersai", custom: "room.routedBy.custom", gemini: "room.routedBy.gemini",
} as const;

export function RoutedByLine({ routedBy }: { routedBy: NonNullable<Message["routedBy"]> }) {
  const percent = Math.round(Math.min(1, Math.max(0, routedBy.probability)) * 100);
  return (
    <div data-testid="routed-by" className="mt-1 px-1 text-[11px] text-ink-secondary">
      {t(ROUTED_BY[routedBy.provider] ?? "room.routedBy", { percent: String(percent) })}
    </div>
  );
}
