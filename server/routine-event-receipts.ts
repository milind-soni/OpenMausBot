// Which run each outside event (a webhook delivery or a connected-app event) went to, kept 7 days so a retry of the
// same event is answered with the same run instead of starting another.
import { z } from "zod";

const receiptSchema = z.object({
  webhookId: z.string().min(1).max(200),
  deliveryId: z.string().min(1).max(200),
  runId: z.string().min(1),
  acceptedAt: z.number().finite().nonnegative(),
});
export type EventRunReceipt = z.infer<typeof receiptSchema>;
export const EVENT_RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_EVENT_RECEIPTS = 20_000;

/** The saved receipts, plus one for each recent run that names its event but lost its receipt. */
export function loadEventReceipts(
  saved: unknown,
  runs: ReadonlyArray<{ id: string; webhookId?: string; deliveryId?: string; createdAt: number }>,
  now: number,
): EventRunReceipt[] {
  const receipts = Array.isArray(saved) ? saved.flatMap((receipt) => {
    const parsed = receiptSchema.safeParse(receipt);
    return parsed.success ? [parsed.data] : [];
  }) : [];
  const known = new Set(receipts.map((receipt) => JSON.stringify([receipt.webhookId, receipt.deliveryId])));
  for (const run of runs) {
    if (!run.webhookId || !run.deliveryId || run.createdAt < now - EVENT_RETRY_WINDOW_MS) continue;
    const key = JSON.stringify([run.webhookId, run.deliveryId]);
    if (known.has(key)) continue;
    receipts.push({ webhookId: run.webhookId, deliveryId: run.deliveryId, runId: run.id, acceptedAt: run.createdAt });
    known.add(key);
  }
  return receipts;
}
