import { t } from "@/lib/i18n";
import { roomQueueLabel, roomThreadQueue } from "@/lib/room-threads";
import type { Bot, Group, Message } from "@/state/store";
import { TurnEffortNote } from "./ConversationalReply";

export function RoomDecisionNotes({ message }: { message: Message }) {
  return <>{message.routedBy && <RoutedByLine routedBy={message.routedBy} />}<TurnEffortNote effort={message.turnEffort} /></>;
}

const nameIn = (members: Bot[]) => (botId: string) => members.find((member) => member.id === botId)?.name;

export function RoomQueueList({ group, members }: { group: Group; members: Bot[] }) {
  const queued = roomThreadQueue(group, group.threadId);
  if (!queued.length) return null;
  const nameOf = nameIn(members);
  return (
    <ul data-testid="room-queue" className="flex flex-col gap-0.5 pl-12 text-[13px] text-ink-secondary">
      {queued.map((entry) => (
        <li key={`${entry.botId}:${entry.position}`}>
          {t("room.queue.member", { name: nameOf(entry.botId) ?? t("sidebar.preview.aBot"), status: roomQueueLabel(entry, nameOf) })}
        </li>
      ))}
    </ul>
  );
}

export function roomMemberQueueTitle(group: Group, members: Bot[], bot: Bot): string | undefined {
  const entry = roomThreadQueue(group, group.threadId).find((candidate) => candidate.botId === bot.id);
  return entry ? t("room.queue.member", { name: bot.name, status: roomQueueLabel(entry, nameIn(members)) }) : undefined;
}

const ROUTED_BY = {
  jev: "room.routedBy", openrouter: "room.routedBy.openrouter", workersai: "room.routedBy.workersai", custom: "room.routedBy.custom",
} as const;

export function RoutedByLine({ routedBy }: { routedBy: NonNullable<Message["routedBy"]> }) {
  const percent = Math.round(Math.min(1, Math.max(0, routedBy.probability)) * 100);
  return (
    <div data-testid="routed-by" className="mt-1 px-1 text-[11px] text-ink-secondary">
      {t(ROUTED_BY[routedBy.provider] ?? "room.routedBy", { percent: String(percent) })}
    </div>
  );
}
