import { escapeAttribute } from "../../src/lib/composer-attachments.ts";
import type { CalendarCall } from "../calendar-calls.ts";
import type { GroupRecord, Store } from "../store.ts";

function sameCalendarRoster(group: GroupRecord, botIds: readonly string[]): boolean {
  if (group.dm || group.memberIds.length !== botIds.length) return false;
  const wanted = new Set(botIds);
  return group.memberIds.every((id) => wanted.has(id));
}

export function createCalendarCallRooms({ store, roomSetupPending, roomAudienceConflict, startGroupTurn, linkRoom }: {
  store: Pick<Store, "group" | "createGroup" | "messagesFor">;
  roomSetupPending: (group: GroupRecord) => boolean;
  roomAudienceConflict: (botIds: readonly string[]) => string | null;
  startGroupTurn: (groupId: string, text: string, sendId: string) => void;
  linkRoom: (callId: string, roomId: string) => void;
}) {
  function ensureCalendarCallRoom(call: CalendarCall): GroupRecord {
    const linked = call.roomId ? store.group(call.roomId) : undefined;
    let group = linked && sameCalendarRoster(linked, call.botIds) && !roomSetupPending(linked)
      ? linked
      : undefined;
    const conflict = group ? null : roomAudienceConflict(call.botIds);
    if (conflict) throw Object.assign(new Error(conflict), { status: 400 });
    group ??= store.createGroup(call.name, call.botIds, false, undefined, {
      bulletin: "",
      defaultResponder: { kind: "everyone" },
      completed: true,
    });
    if (call.roomId !== group.id) linkRoom(call.id, group.id);
    return group;
  }

  function deliverCalendarCall(call: CalendarCall, scheduledFor: number): void {
    if (call.botIds.length < 2) return;
    let group: GroupRecord;
    try {
      group = ensureCalendarCallRoom(call);
    } catch (error) {
      console.warn(`calendar call "${call.name}" did not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const text = [
      `@everyone ${call.description.trim() || call.name}`,
      ...call.attachments.map((attachment) =>
        `<${attachment.kind === "image" ? "attached-image" : "attached-file"} path="${escapeAttribute(attachment.path)}" name="${escapeAttribute(attachment.name)}" />`
      ),
    ].join("\n\n");
    const sendId = `calendar_${call.id}_${scheduledFor}`;
    const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
    const messages = [...threadIds].flatMap((threadId) => store.messagesFor(threadId));
    if (messages.some((message) => message.sendId === sendId)) return;
    startGroupTurn(group.id, text, sendId);
  }

  return { ensureCalendarCallRoom, deliverCalendarCall };
}
