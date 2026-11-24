import type { Notification, NotifyKind } from "../../../shared/notification";
import type { SoundEvent } from "./render";

export const NOTIFICATION_SOUNDS: Record<NotifyKind, SoundEvent | null> = {
  approval: "attention",
  question: "attention",
  "sign-in": "attention",
  secret: "attention",
  spend: "attention",
  brief: "attention",
  "routine-deferred": "attention",
  done: "done",
  "delegation-settled": "done",
  wait: "done",
  "routine-failed": "error",
  "turn-failed": "error",
  incident: "error",
  mention: "mention",
  notice: null,
};

/** Notices about one thread or room that land this close together are one sound. */
export const GROUP_WINDOW_MS = 2000;
const REMEMBERED = 200;

export type NotificationSoundEntry = Pick<Notification, "kind" | "threadId" | "groupId"> & { id?: string; read?: boolean };

export function createEventSounds(deps: {
  play: (event: SoundEvent) => boolean;
  now: () => number;
  finishedNotices: () => boolean;
}) {
  const heard = new Set<string>();
  const groupHeard = new Map<string, number>();
  const firstTime = (id: string | undefined) => {
    if (!id) return true;
    if (heard.has(id)) return false;
    heard.add(id);
    if (heard.size > REMEMBERED) heard.delete(heard.values().next().value as string);
    return true;
  };

  return {
    /** `viewing`: the person has this thread open in a focused window, where its reply already made a sound. */
    notified(entry: NotificationSoundEntry, viewing: boolean): boolean {
      const event = NOTIFICATION_SOUNDS[entry.kind];
      if (!event || entry.read || !firstTime(entry.id)) return false;
      if (event === "done" && (viewing || !deps.finishedNotices())) return false;
      const group = `${event}:${entry.groupId ?? entry.threadId}`;
      const now = deps.now();
      const last = groupHeard.get(group);
      if (last !== undefined && now - last < GROUP_WINDOW_MS) return false;
      groupHeard.set(group, now);
      return deps.play(event);
    },
    replied(messageId: string, inView: boolean): boolean {
      if (!inView || !firstTime(`message:${messageId}`)) return false;
      return deps.play("reply");
    },
  };
}
