/** The chip in a card's top-right corner.
 *
 * Everything here is derived from state the client already holds — no new
 * server fields. The ordering matters more than the wording: a card that needs
 * you must not be outranked by one that is merely busy.
 */

import type { Bot, Group } from "@/state/store";

export type StatusTone = "attention" | "active" | "danger" | "muted" | "unread";

export interface StatusChip {
  label: string;
  tone: StatusTone;
}

function isGroup(subject: Bot | Group): subject is Group {
  return Array.isArray((subject as Group).memberIds);
}

export function statusChip(subject: Bot | Group): StatusChip {
  if (isGroup(subject)) {
    if (subject.working || subject.busyBotId) return { label: "Working", tone: "active" };
    if (subject.unread) return { label: "New messages", tone: "unread" };
    return { label: "Idle", tone: "muted" };
  }

  switch (subject.activity) {
    case "waiting-on-you":
      return { label: "Waiting on you", tone: "attention" };
    case "working":
      return { label: "Working", tone: "active" };
    case "dead":
      return { label: "Stopped", tone: "danger" };
    case "no-signal":
      return { label: "No signal", tone: "muted" };
    default:
      break;
  }
  // `busy` is the older signal; a bot can be busy before activity catches up.
  if (subject.busy) return { label: "Working", tone: "active" };
  if (subject.unread) return { label: "New messages", tone: "unread" };
  return { label: "Idle", tone: "muted" };
}

export const TONE_CLASS: Record<StatusTone, string> = {
  attention: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
  danger: "bg-danger/15 text-danger",
  unread: "bg-accent/15 text-accent",
  muted: "bg-raised text-ink-secondary",
};
