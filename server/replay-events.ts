import type { RuntimeEvent } from "./contracts.ts";
import type { createReplayLedger, ReplayRef } from "./replay-guard.ts";

type Ledger = ReturnType<typeof createReplayLedger>;
const CLAUDE_READS = new Set(["Read", "Glob", "Grep"]);

export function createReplayEvents(ledger: Ledger) {
  const active = new Map<string, {
    ref: ReplayRef; instance: string; turnId?: string; retired: Set<string>; inline: boolean; activity: boolean;
    submission?: "guarded" | "opaque"; providerRefused: boolean; approvals: Set<string>; sealed: boolean;
  }>();
  function begin(threadId: string, ref: ReplayRef, instance: string, inline = false): void {
    const previous = active.get(threadId);
    const retired = previous?.retired ?? new Set<string>();
    if (previous?.turnId) retired.add(previous.turnId);
    if (retired.size > 32) retired.delete(retired.values().next().value!);
    active.set(threadId, { ref, instance, retired, inline, activity: false, providerRefused: false, approvals: new Set(), sealed: false });
  }
  function matches(event: RuntimeEvent): boolean {
    const run = active.get(event.threadId);
    return Boolean(run && event.turnId && !run.retired.has(event.turnId) &&
      (!run.turnId || run.turnId === event.turnId) && event.providerInstanceId === run.instance);
  }
  function bind(threadId: string, turnId: string | undefined) {
    const run = active.get(threadId);
    if (run && turnId && !run.turnId && !run.retired.has(turnId)) { run.turnId = turnId; ledger.bindProviderTurn(run.ref, turnId); }
  }
  function submitted(threadId: string, guarded: boolean): void {
    const run = active.get(threadId);
    if (run) run.submission = guarded ? "guarded" : "opaque";
  }
  function finish(threadId: string, outcome: "failed" | "complete" | "interrupted", proof?: "startup-refusal" | "guarded-startup-refusal", quota?: string) {
    const run = active.get(threadId);
    if (!run || run.sealed) return false;
    const safe = !run.activity && (proof === "startup-refusal" ||
      (proof === "guarded-startup-refusal" && run.submission !== "opaque") ||
      (run.submission === "guarded" && run.providerRefused));
    run.sealed = true;
    return ledger.finish(run.ref, outcome, safe ? "confirmed:no-dispatch" : "uncertain", quota);
  }
  function observe(event: RuntimeEvent): void {
    const run = active.get(event.threadId);
    if (!run || !event.turnId || run.retired.has(event.turnId) || event.providerInstanceId !== run.instance) return;
    if (run.turnId && run.turnId !== event.turnId) return;
    if (run.sealed) return;
    bind(event.threadId, event.turnId);
    if (event.type === "turn.completed") run.providerRefused = !event.ok && event.replayNoDispatch === true;
    if (event.type === "turn.serving-model") ledger.servingModel(run.ref, event.model);
    if (!event.synthetic && event.type === "item.completed" && event.itemType === "assistant_text" && event.text.trim()) run.activity = true;
    if (event.type === "request.opened") {
      run.activity = true;
      const id = "approval:" + (event.requestId ?? event.eventId);
      ledger.reserveAction(run.ref, id, "effect");
      if (event.requestId && event.requestType === "permission") run.approvals.add(event.requestId);
    }
    if (event.type === "item.started" && event.itemType === "tool") {
      const id = "tool:" + (event.itemId ?? event.eventId);
      const read = event.provider === "claudeAgent" && CLAUDE_READS.has(event.title ?? "");
      run.activity = true;
      if (ledger.reserveAction(run.ref, id, read ? "read" : "effect")) {
        ledger.actionState(run.ref, id, "dispatched");
      }
    }
    if (event.type === "item.completed" && event.itemType === "tool") {
      const id = "tool:" + (event.itemId ?? event.eventId);
      if (!(event.ok ? ledger.actionReceipt(run.ref, id, "completed", "provider-event") : ledger.actionState(run.ref, id, "unknown"))) {
        run.activity = true;
        if (ledger.reserveAction(run.ref, id, "effect")) {
          ledger.actionState(run.ref, id, "dispatched");
          ledger.actionState(run.ref, id, "unknown");
        }
      }
    }
  }
  function nativeTool(threadId: string, id: string, tool: string, input: unknown): boolean {
    const run = active.get(threadId);
    if (!run || run.sealed) return false;
    const read = CLAUDE_READS.has(tool);
    if (!ledger.authorizeNativeAction(run.ref, "tool:" + id, read ? "read" : "effect", [tool, input])) return false;
    run.activity = true;
    return true;
  }
  function approvalIsCurrent(threadId: string, requestId: string) {
    const run = active.get(threadId);
    return Boolean(run && !run.sealed && run.approvals.has(requestId));
  }
  function duplicateTerminal(event: RuntimeEvent): boolean {
    const run = active.get(event.threadId);
    return event.type === "turn.completed" && Boolean(event.turnId && run &&
      (run.retired.has(event.turnId) || (run.sealed && matches(event))));
  }
  function intercepted(event: RuntimeEvent) {
    const run = active.get(event.threadId);
    if (run?.inline && event.type === "turn.completed" && matches(event)) finish(event.threadId, event.ok ? "complete" : "interrupted");
  }
  return { begin, bind, submitted, finish, observe, intercepted, duplicateTerminal, nativeTool, matches, approvalIsCurrent,
    knowsApproval: (threadId: string, requestId: string) => active.get(threadId)?.approvals.has(requestId), ref: (threadId: string) => active.get(threadId)?.ref };
}
