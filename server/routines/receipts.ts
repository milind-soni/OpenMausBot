// Receipts: durable identity records that make routine requests and webhook
// deliveries exact-once across restarts. Request-receipt state lives here in
// RoutineRequestReceiptLedger; webhook receipt state stays on RoutineManager
// (enqueueWebhook rolls it back inline), which uses the schema, loader, and
// lookup helpers below. Bodies moved verbatim from manager.ts.
import { z } from "zod";

import type { RoutineRequestOperation } from "../../shared/routine-request.ts";
import type {
  RoutineRequestCommit,
  RoutineRequestOwner,
  RoutineRequestReceipt,
  RoutineRun,
} from "./types.ts";

const ROUTINE_REQUEST_ACTIONS = new Set<RoutineRequestOperation["action"]>([
  "create",
  "update",
  "pause",
  "resume",
  "run_now",
  "delete",
]);

function isRoutineRequestAction(value: unknown): value is RoutineRequestOperation["action"] {
  return typeof value === "string" && ROUTINE_REQUEST_ACTIONS.has(value as RoutineRequestOperation["action"]);
}

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export const webhookRunReceiptSchema = z.object({
  webhookId: z.string().min(1).max(200),
  deliveryId: z.string().min(1).max(200),
  runId: z.string().min(1),
  acceptedAt: z.number().finite().nonnegative(),
});
export type WebhookRunReceipt = z.infer<typeof webhookRunReceiptSchema>;
export const WEBHOOK_RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_WEBHOOK_RECEIPTS = 20_000;

/** Parse the persisted webhook receipt array, dropping malformed entries. */
export function loadWebhookRunReceipts(value: unknown): WebhookRunReceipt[] {
  return Array.isArray(value)
    ? value.flatMap((receipt) => {
        const parsed = webhookRunReceiptSchema.safeParse(receipt);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

/** Look up an accepted delivery independently of run-log retention. */
export function findWebhookRun(
  webhookId: string,
  deliveryId: string,
  receipts: readonly WebhookRunReceipt[],
  runs: readonly RoutineRun[],
  now: number,
): { id: string } | null {
  const receipt = receipts.find((candidate) =>
    candidate.webhookId === webhookId && candidate.deliveryId === deliveryId &&
    candidate.acceptedAt >= now - WEBHOOK_RETRY_WINDOW_MS);
  if (receipt) return { id: receipt.runId };
  // Never duplicate work that is still pending, even beyond the retry window.
  const active = runs.find((run) => run.webhookId === webhookId && run.deliveryId === deliveryId &&
    ["queued", "running", "waiting"].includes(run.status));
  return active ? { id: active.id } : null;
}

/** Durable commit receipts for cross-file confirmation recovery. Mutations
 * run through the injected commit callback so they stay atomic with
 * RoutineManager's save-or-rollback semantics. */
export class RoutineRequestReceiptLedger {
  private receipts: RoutineRequestReceipt[] = [];
  private readonly commit: (mutate: () => void) => void;

  constructor(commit: (mutate: () => void) => void) {
    this.commit = commit;
  }

  load(value: unknown): void {
    this.receipts = Array.isArray(value)
      ? value.filter((receipt): receipt is RoutineRequestReceipt =>
          typeof receipt?.requestId === "string" &&
          typeof receipt?.messageId === "string" &&
          typeof receipt?.botId === "string" &&
          typeof receipt?.threadId === "string" &&
          isRoutineRequestAction(receipt?.action) &&
          receipt?.fingerprintVersion === 1 &&
          typeof receipt?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
          typeof receipt?.resultId === "string" &&
          Number.isFinite(receipt?.appliedAt)
        )
      : [];
  }

  reset(): void {
    this.receipts = [];
  }

  /** The live array for the persisted document; shape unchanged. */
  persisted(): RoutineRequestReceipt[] {
    return this.receipts;
  }

  snapshot(): RoutineRequestReceipt[] {
    return this.receipts.map((receipt) => ({ ...receipt }));
  }

  restore(receipts: RoutineRequestReceipt[]): void {
    this.receipts = receipts;
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.receipts.find((candidate) => candidate.requestId === requestId);
    return receipt ? { ...receipt } : null;
  }

  /** Small startup index used to locate only transcripts that may need
   * cross-file commit recovery. Most launches have no receipts and therefore
   * do not read or cache any transcript for this feature. */
  routineRequestReceiptOwners(): RoutineRequestOwner[] {
    return this.receipts.map(({ requestId, messageId, botId, threadId }) => ({
      requestId,
      messageId,
      botId,
      threadId,
    }));
  }

  /** Once the transcript card is durably settled, its scheduler receipt is
   * redundant. Unsettled receipts are intentionally never count-evicted: an
   * actionable card may survive indefinitely and must retain its exact-once
   * recovery record for the same lifetime. */
  forgetRoutineRequestReceipt(request: RoutineRequestCommit): boolean {
    const receipt = this.matchingRoutineRequestReceipt(request);
    if (!receipt) return false;
    const index = this.receipts.indexOf(receipt);
    this.commit(() => {
      this.receipts.splice(index, 1);
    });
    return true;
  }

  forgetRoutineRequestReceiptsForThread(threadId: string): number {
    const kept = this.receipts.filter((receipt) => receipt.threadId !== threadId);
    const removed = this.receipts.length - kept.length;
    if (removed === 0) return 0;
    this.commit(() => {
      this.receipts = kept;
    });
    return removed;
  }

  /** Drop only receipts whose confirmation transcript no longer exists.
   * Reachable open cards retain exact-once recovery for their full lifetime. */
  reconcileRoutineRequestReceipts(reachable: readonly RoutineRequestOwner[]): number {
    const keys = new Set(reachable.map(routineRequestOwnerKey));
    const kept = this.receipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
    const removed = this.receipts.length - kept.length;
    if (removed === 0) return 0;
    this.commit(() => {
      this.receipts = kept;
    });
    return removed;
  }

  matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null {
    const receipt = this.receipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt) return null;
    if (
      receipt.action !== request.action ||
      receipt.messageId !== request.messageId ||
      receipt.botId !== request.botId ||
      receipt.threadId !== request.threadId ||
      receipt.fingerprintVersion !== request.fingerprintVersion ||
      receipt.fingerprint !== request.fingerprint
    ) {
      throw new Error("Routine request receipt does not match this confirmation card");
    }
    return receipt;
  }

  rememberRoutineRequest(
    request: RoutineRequestCommit,
    resultId: string,
    appliedAt: number,
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) {
      if (existing.resultId !== resultId) throw new Error("Routine request receipt has another result");
      return;
    }
    this.receipts.unshift({ ...request, resultId, appliedAt });
  }
}
