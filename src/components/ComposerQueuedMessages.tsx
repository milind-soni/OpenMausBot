import { CornerDownRight, Trash2 } from "lucide-react";

/** Messages the harness is holding until the running turn settles, stacked
 * directly above the composer in send order.
 *
 * They are deliberately not in the transcript — appending one now would make
 * it the active leaf and the rest of the turn would hang off a line the model
 * never saw — so this row is the only place they exist on screen. Both
 * actions are words: Steer stops the turn so these words run now (the harness
 * keeps its queue across an interrupt, which is what makes stopping a send),
 * and the bin drops them. */
export function QueuedComposerMessages({
  items,
  onSteer,
  onCancel,
}: {
  items: Array<{ queueId: string; text: string }>;
  /** Absent where this surface cannot interrupt, so the button is not
   * offered rather than offered and broken. */
  onSteer?: () => void;
  onCancel: (queueId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-label="Queued messages">
      {items.map((item) => (
        <div
          key={item.queueId}
          className="flex items-center gap-2 rounded-2xl bg-raised/70 py-1.5 pl-3 pr-1.5"
        >
          <CornerDownRight size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{item.text}</span>
          {onSteer && (
            <button
              type="button"
              onClick={onSteer}
              title="Stop the current turn so this message runs now"
              className="flex shrink-0 items-center gap-1 rounded-full bg-hairline/60 px-2.5 py-1 text-[13px] text-ink hover:bg-hairline"
            >
              <CornerDownRight size={12} strokeWidth={2.5} aria-hidden="true" />
              Steer
            </button>
          )}
          <button
            type="button"
            onClick={() => onCancel(item.queueId)}
            aria-label="Delete this queued message"
            title="Delete this queued message"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
