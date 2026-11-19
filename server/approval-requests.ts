// Explicit Buddy consent (as distinct from a provider's automatic tool prompt).
// No operation runs here: the requesting tool waits for a human decision.
import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
  id: string;
  botId: string;
  threadId: string;
  tool: string;
  summary: string;
}
export interface ApprovalDecision { approved: boolean; always: boolean; reason?: string }
interface Pending { request: ApprovalRequest; settle: (decision: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }

export class ApprovalRequests {
  private pending = new Map<string, Pending>();
  private opened: (request: ApprovalRequest) => void;
  private resolved: (request: ApprovalRequest, decision: ApprovalDecision) => void;
  constructor(opened: ApprovalRequests["opened"], resolved: ApprovalRequests["resolved"]) {
    this.opened = opened;
    this.resolved = resolved;
  }
  open(input: Omit<ApprovalRequest, "id">, timeoutMs = 30 * 60_000) {
    const request = { ...input, id: `studio-approval:${randomUUID()}` };
    const result = new Promise<ApprovalDecision>(settle => {
      const timer = setTimeout(() => this.finish(request.id, { approved: false, always: false, reason: "Approval expired." }), timeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { request, settle, timer });
    });
    this.opened(request);
    return { id: request.id, result };
  }
  get(id: string, botId: string, threadId: string) {
    const entry = this.pending.get(id);
    return entry?.request.botId === botId && entry.request.threadId === threadId ? entry.request : undefined;
  }
  respond(id: string, botId: string, threadId: string, decision: ApprovalDecision) {
    if (!this.get(id, botId, threadId)) return false;
    this.finish(id, decision);
    return true;
  }
  cancel(id: string, reason: string) { this.finish(id, { approved: false, always: false, reason }); }
  cancelThread(threadId: string) {
    for (const { request } of this.pending.values()) if (request.threadId === threadId) this.cancel(request.id, "Turn stopped before approval.");
  }
  cancelAll() { for (const id of this.pending.keys()) this.cancel(id, "Studio stopped before approval."); }
  private finish(id: string, decision: ApprovalDecision) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.resolved(entry.request, decision);
    entry.settle(decision);
  }
}

export const APPROVAL_BOX_RULES = "When an action needs the user's permission, call request_approval and wait for its result instead of asking for approval in plain chat or telling the user to type proceed. This shows the existing Allow / Deny / Always allow box. Explain the exact action, affected files, and destination in summary. Use a stable action id and a narrow scope (for file copies, the destination folder) so Always allow only covers that same action and scope for you. Proceed only when approved is true. Deny, dismissal, cancellation and timeout mean do not perform the action. Do not ask again when the user has already authorized that action. Questions and preferences are separate from action approvals.";
