import type { ActionKind, BenchmarkAdapter, EvidenceEvent } from "./types.ts";

export type AdapterOptions = {
  dryRun?: boolean;
  approvedActionIds?: readonly string[];
  clockStartMs?: number;
};

export type DeterministicAdapter = BenchmarkAdapter;

/** Named fixture inputs make scenario coverage reviewable without requiring
 * a live account or OS application. They intentionally contain no secrets. */
export const DETERMINISTIC_FIXTURES = Object.freeze({
  browser: { approvedUrl: "https://example.test/inbox", receipt: "inbox/item-17", fresh: true },
  windows: { application: "fixture-editor", document: "sandbox/document.txt", productionTouched: false },
  research: { sources: ["source-a", "source-b"], decision: "option-a", confidence: "high" },
  auth: { source: "gmail-account-1", initialStatus: "needs-auth", cursorAdvancesOnlyAfterSuccess: true },
  unattended: { simulatedHours: [0, 1, 2], checkpoints: ["0h", "1h", "2h"] },
  privacy: { sensitiveFixture: "fixture/private-note", redacted: true, externalSendRequiresApproval: true },
});

const SIDE_EFFECT_KINDS = new Set<ActionKind>(["execute", "windows"]);

/** Deterministic, network-free adapter. It models the seams that matter to
 * the benchmark (browser receipts, desktop operations, auth, cursors, and
 * approval gates) without opening a real browser or touching user state. */
export function createDeterministicAdapter(options: AdapterOptions = {}): DeterministicAdapter {
  const events: EvidenceEvent[] = [];
  const approved = new Set(options.approvedActionIds ?? []);
  const start = options.clockStartMs ?? 1_725_000_000_000;
  const seenFailures = new Set<string>();
  let clock = start;
  return {
    name: "deterministic-fixture",
    evidenceMode: "fixture",
    perform(scenarioId, action, attempt) {
      const eventBase: Omit<EvidenceEvent, "status"> = {
        id: `${scenarioId}:${action.id}:${attempt}`,
        scenarioId,
        actionId: action.id,
        kind: action.kind,
        attempt,
        timestampMs: clock,
        latencyMs: action.latencyMs,
        costUsd: action.costUsd,
        tokens: typeof action.data?.tokens === "number" ? action.data.tokens : 0,
        // Fixture assertions describe the simulated world only. They are
        // deliberately not independent postcondition evidence.
        data: { target: action.target, ...action.data, evidenceMode: "fixture", outcomeVerified: false },
      };
      if (action.agentId) eventBase.agentId = action.agentId;
      clock += action.latencyMs;
      let status: EvidenceEvent["status"] = "ok";
      const data = { ...eventBase.data };
      if (options.dryRun && (action.sideEffect || SIDE_EFFECT_KINDS.has(action.kind))) {
        status = "dry-run";
        data.dryRun = true;
      } else if (action.requiresApproval && !approved.has(action.id)) {
        status = "blocked";
        data.approvalRequired = true;
      } else if (action.failure === "always" || (action.failure === "once" && !seenFailures.has(action.id))) {
        status = action.kind === "auth" ? "needs-auth" : "failed";
        data.retryable = action.failure === "once";
        seenFailures.add(action.id);
      }
      const event = { ...eventBase, status, data };
      events.push(event);
      return event;
    },
    get events() {
      return events;
    },
  };
}
