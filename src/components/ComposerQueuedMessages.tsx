import { CornerDownRight, Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";

export function composerCanSteerQueuedMessages(
  busy: boolean,
  locked: boolean,
  pendingCount: number,
  approvalPending = false,
): boolean {
  return busy && !locked && !approvalPending && pendingCount > 0;
}

/** Messages held by the harness until the running turn settles.
 *
 * The queue sits directly above the composer rather than pretending these
 * words are already part of the transcript. Only its head owns Steer: room
 * queues drain one item at a time, while bot queues coalesce all waiting
 * items into one follow-up. Delete remains available on every exact queue id.
 */
export function QueuedComposerMessages({
  items,
  onSteer,
  steerMode = "all",
  steering = false,
  onCancel,
}: {
  items: Array<{ queueId: string; text: string; reason?: "capacity" }>;
  onSteer?: () => void;
  steerMode?: "all" | "next";
  steering?: boolean;
  onCancel: (queueId: string) => void;
}) {
  if (!items.length) return null;

  const multiple = items.length > 1;
  const steerLabel = steering
    ? t("composer.queued.steering")
    : multiple
      ? steerMode === "all"
        ? t("composer.queued.steerAll")
        : t("composer.queued.steerNext")
      : t("composer.queued.steer");
  const steerDescription = multiple
    ? steerMode === "all"
      ? t("composer.queued.steerAllHint", { count: items.length })
      : t("composer.queued.steerNextHint")
    : t("composer.queued.steerHint");

  return (
    <div
      className="relative z-[1] mx-3 -mb-3 max-h-36 overflow-y-auto rounded-t-2xl border border-b-0 border-hairline/40 bg-raised/95 pb-3 shadow-sm backdrop-blur-sm"
      aria-label={
        items.length === 1
          ? t("composer.queued.regionOne")
          : t("composer.queued.regionMany", { count: items.length })
      }
      aria-live="polite"
    >
      {items.some((item) => item.reason === "capacity") && (
        <p className="px-3 pt-2 text-[12px] text-ink-secondary">{t("composer.queued.capacity")}</p>
      )}
      <ul className="divide-y divide-hairline/25" aria-label={t("composer.queued.list")}>
        {items.map((item, index) => (
          <li key={item.queueId} className="flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5">
            <CornerDownRight
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-ink-secondary"
              aria-hidden="true"
            />
            <span dir="auto" className="min-w-0 flex-1 truncate text-[14px] text-ink" title={item.text}>
              {item.text}
            </span>
            {index === 0 && onSteer && (
              <button
                type="button"
                onClick={onSteer}
                disabled={steering}
                aria-label={steering ? t("composer.queued.steeringAria") : steerDescription}
                title={steerDescription}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait disabled:opacity-60"
              >
                <CornerDownRight
                  size={13}
                  strokeWidth={2}
                  className={steering ? "animate-pulse" : undefined}
                  aria-hidden="true"
                />
                {steerLabel}
              </button>
            )}
            <button
              type="button"
              onClick={() => onCancel(item.queueId)}
              aria-label={t("composer.queued.deleteAria", { index: index + 1, count: items.length })}
              title={t("composer.queued.deleteTitle")}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
