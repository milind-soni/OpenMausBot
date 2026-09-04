// Approvals for the owned loop, failing closed.
//
// This is the in-process counterpart of the CLI drivers' permission broker
// (claude.ts createPermissionBroker), with the same rules and the same
// wording, minus the socket: a tool call asks, the harness answers through
// the ordinary card / auto-approve flow, and the answer arrives via
// respondToRequest. Every way an answer can fail to arrive resolves to a
// DENY — the answerer went away, the turn ended, the request was never
// pending, time ran out. An unanswered ask never becomes an allow.
import { newId } from "../contracts.ts";
import type { RequestOutcome } from "../contracts.ts";

export type AskKind = "permission" | "question";
export type AskBehavior = "allow" | "deny" | "answer";
export type AskSource = "user" | "timeout" | "system" | "unavailable";

export const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
export const QUESTION_TIMEOUT_NOTE = "OpenMausBot: nobody answered in time. Use your best judgment and continue.";
export const DUPLICATE_ASK_ID_NOTE = "OpenMausBot: duplicate ask id — skipping this request.";
/** Same default as the CLI broker: a person may be away from the keyboard
 * for a while, and a denied ask cannot be un-denied. */
export const ASK_TIMEOUT_MS = 15 * 60_000;

export interface Ask {
  id: string;
  kind: AskKind;
  tool: string;
  summary: string;
  choices?: string[];
}

export interface AskResolution {
  behavior: AskBehavior;
  message?: string;
  source: AskSource;
}

/** The system-source reply for an ask that outlives the turn. */
export function systemEndedReply(kind: AskKind): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "OpenMausBot: the turn is ending — wrap up." }
    : { behavior: "deny", message: "OpenMausBot: the turn ended" };
}

export interface ApprovalGateOptions {
  /** the ask is now open — the driver turns this into request.opened. */
  onOpen: (ask: Ask) => void;
  /** the ask is settled, however it settled — request.resolved. */
  onResolve: (ask: Ask, resolution: AskResolution) => void;
  timeoutMs?: number;
}

export interface ApprovalGate {
  /** Open an ask and wait for its answer. Never rejects: every failure to
   * answer is a deny. */
  ask(input: Omit<Ask, "id"> & { id?: string }): Promise<AskResolution>;
  /** The harness's answer. `unavailable` when nothing by that id is
   * pending — the caller treats it as a deny, never retries as an allow. */
  answer(requestId: string, behavior: AskBehavior, message?: string): RequestOutcome;
  /** Settle everything still open with the system reply. Turn end, cancel,
   * and dispose all come here. */
  drain(): void;
  pending(): number;
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
  const pending = new Map<string, { ask: Ask; finish: (r: AskResolution) => void }>();

  return {
    ask(input) {
      const ask: Ask = { ...input, id: input.id ?? newId() };
      return new Promise<AskResolution>((resolve) => {
        if (pending.has(ask.id)) {
          // a second ask with a live id is denied outright, never merged:
          // merging would let one answer settle two different actions
          const resolution: AskResolution = { behavior: "deny", message: DUPLICATE_ASK_ID_NOTE, source: "system" };
          options.onResolve(ask, resolution);
          resolve(resolution);
          return;
        }
        let settled = false;
        const finish = (resolution: AskResolution) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(ask.id);
          options.onResolve(ask, resolution);
          resolve(resolution);
        };
        const timer = setTimeout(
          () =>
            ask.kind === "question"
              ? finish({ behavior: "answer", message: QUESTION_TIMEOUT_NOTE, source: "timeout" })
              : finish({ behavior: "deny", message: DENY_TIMEOUT_NOTE, source: "timeout" }),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(ask.id, { ask, finish });
        options.onOpen(ask);
      });
    },
    answer(requestId, behavior, message) {
      const entry = pending.get(requestId);
      if (!entry) return "unavailable";
      // a question can only be answered; an allow/deny on it is not a
      // decision about the question, so it is treated as an answer text
      const applied: AskBehavior = entry.ask.kind === "question" ? "answer" : behavior;
      entry.finish({ behavior: applied, message, source: "user" });
      return applied === "allow" ? "allowed-once" : applied === "answer" ? "answered" : "rejected";
    },
    drain() {
      // finish() deletes the current entry; a Map tolerates that mid-iteration
      for (const { ask, finish } of pending.values()) {
        finish({ ...systemEndedReply(ask.kind), source: "system" });
      }
    },
    pending: () => pending.size,
  };
}
