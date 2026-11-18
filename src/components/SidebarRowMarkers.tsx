import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The colour behind a Simple row, which the status dot on its avatar is ring-cut against. */
export function rowSurface(selected: boolean): string {
  return selected
    ? "[--row:var(--color-raised)]"
    : "[--row:var(--color-panel)] max-md:[--row:var(--color-app)] hover:[--row:color-mix(in_srgb,var(--color-raised)_50%,var(--color-panel))]";
}

/** The conversation the chat window has open: the same plain fill as a selected row. */
export const rowSelectedSurface = "bg-raised";

export type RowActivity = "working" | "failed" | "teammate" | "queued";

const ACTIVITY = {
  working: { tone: "bg-success", label: () => t("chat.activity.working"), testId: "working-dot" },
  failed: { tone: "bg-danger", label: () => t("sidebar.preview.failed"), testId: "failed-dot" },
  teammate: { tone: "bg-accent", label: () => t("sidebar.preview.waitingOnTeammate"), testId: "teammate-wait-dot" },
  queued: { tone: "bg-ink-secondary", label: () => t("task.queued"), testId: "queued-dot" },
} as const satisfies Record<RowActivity, { tone: string; label: () => string; testId: string }>;

/** Working, waiting on a teammate or queued: a small dot on the avatar's corner. */
export function AvatarActivityDot({ activity }: { activity: RowActivity | null }) {
  if (!activity) return null;
  const { tone, label, testId } = ACTIVITY[activity];
  return <span aria-hidden="true" data-testid={testId} title={label()} className={cn("absolute bottom-0.5 right-0.5 size-2 rounded-full ring-2 ring-[var(--row)]", tone)} />;
}

/** The same marker on a full row's avatar: a larger dot on its bottom-right corner, cut against the panel. */
export function AvatarCornerDot({ activity, large }: { activity: Exclude<RowActivity, "working"> | null; large: boolean }) {
  if (!activity) return null;
  const { tone, label, testId } = ACTIVITY[activity];
  return <span data-testid={testId} role="status" aria-label={label()} title={label()}
    className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel", tone, large ? "size-3" : "size-2.5")} />;
}

/** Unread, or waiting for the person (which wins): one dot at the row's top right, in the spot its ⋯ takes on hover
 * or focus. A touch screen always shows the ⋯, so there the dot sits just before it, at the end of the name line. */
export function RowDot({ waiting = false }: { waiting?: boolean }) {
  const label = waiting ? t("sidebar.preview.waiting") : t("task.unread");
  const tone = cn("size-2 shrink-0 rounded-full", waiting ? "bg-warning" : "bg-accent");
  return (
    <>
      <span aria-hidden="true" data-row-dot="" className="pointer-events-none absolute right-[3px] top-1.5 flex size-6 items-center justify-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 touch:opacity-0 max-md:hidden">
        <span data-testid={waiting ? "waiting-dot" : "unread-dot"} title={label} className={tone} />
      </span>
      <span aria-hidden="true" title={label} className={cn(tone, "hidden self-center max-md:block touch:block")} />
    </>
  );
}

/** What the row's markers show, said once for a screen reader; a waiting row's preview already says it. */
export function RowStatusText({ working = false, failed = false, unread }: { working?: boolean; failed?: boolean; unread: boolean }) {
  const text = [working ? t("chat.activity.working") : "", failed ? t("sidebar.preview.failed") : "", unread ? t("task.unread") : ""].filter(Boolean).join(", ");
  return text ? <span className="sr-only">{text}</span> : null;
}
