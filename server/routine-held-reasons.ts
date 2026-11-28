import type { RuntimeEvent } from "../shared/runtime-events.ts";

const MAX_HELD_REASONS = 500;
const heldReasonsByRequest = new Map<string, string>();

/** Records why an approval card was held so routine timeouts can surface that reason later. Returns `reason`. */
export function recordHeldReason(threadId: string, requestId: string | undefined, reason: string | undefined): string | undefined {
  if (!requestId || !reason) return reason;
  if (heldReasonsByRequest.size >= MAX_HELD_REASONS) {
    const oldest = heldReasonsByRequest.keys().next().value;
    if (oldest !== undefined) heldReasonsByRequest.delete(oldest);
  }
  heldReasonsByRequest.set(`${threadId}:${requestId}`, reason);
  return reason;
}

/** Attaches and clears any recorded held reason when a permission request resolves. */
export function withHeldReason<T extends RuntimeEvent>(event: T): T {
  if (event.type !== "request.resolved" || !event.requestId) return event;
  const key = `${event.threadId}:${event.requestId}`;
  const heldReason = heldReasonsByRequest.get(key);
  heldReasonsByRequest.delete(key);
  return heldReason ? { ...event, heldReason } : event;
}

export function clearHeldReasons(): void {
  heldReasonsByRequest.clear();
}
