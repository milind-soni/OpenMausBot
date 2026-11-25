import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeStderrResumeRefusal, mayResendTurn } from "./drivers/retry.ts";
import { createReplayLedger, requireReplayAdmission, type ReplayRef, type ReplayScope } from "./replay-guard.ts";
import { createReplayEvents } from "./replay-events.ts";
import { readReplayAudit } from "./testing/replay-audit.ts";

// The three replay states: A (positive no-dispatch evidence) is admitted once; B (a recorded dispatch or action) and
// C (missing, unknown or inconsistent history) fail closed and leave the task for reconciliation.
const ref: ReplayRef = { logicalTaskId: "task", generation: "request-1" };
const scope: ReplayScope = { owner: "owner", threadId: "thread", approval: "ask", tools: ["native:Read"], workspace: "/fixture", authority: {} };
const model = { configuredInstance: "primary", configuredModel: "configured", requestId: "request-message" };
const ledgerModule = new URL("./replay-guard.ts", import.meta.url).href;
let dir: string, file: string, ledger: ReturnType<typeof createReplayLedger>;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "replay-states-")); file = join(dir, "replay-safety.db"); ledger = createReplayLedger(file); });
afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

const audit = () => readReplayAudit(dir);
const guard = (source = ref) => ledger.replayGuard(source.logicalTaskId, source.generation, "startup-refusal", scope);
function submitted() { expect(ledger.begin(ref, scope, model)).toBe(true); expect(ledger.markSubmitted(ref, { scope })).toBe(true); }

describe("state A: positive evidence that nothing ran", () => {
  it("admits a provider-refused submission exactly once and records the new generation", () => {
    submitted();
    expect(ledger.finish(ref, "failed", "confirmed:no-dispatch")).toBe(true);
    expect(ledger.positiveEvidence(ref)).toBe(true);
    const next = guard();
    expect(next).toMatchObject({ logicalTaskId: ref.logicalTaskId });
    expect(next!.generation).not.toBe(ref.generation);
    expect(guard()).toBeUndefined();
    expect(audit().decisions.map((row: any) => row.decision)).toEqual(["admitted", "superseded"]);
  });

  it("reads Claude's dead-cursor refusal on stderr only for the exact cursor it resumed", () => {
    expect(claudeStderrResumeRefusal("fake-claude: No conversation found with session ID: s-1\n", "s-1")).toMatchObject({ sessionMissing: true });
    expect(claudeStderrResumeRefusal("No conversation found with session ID: s-1", "s-1")).toMatchObject({ sessionMissing: true });
    expect(claudeStderrResumeRefusal("No conversation found with session ID: s-2\n", "s-1")).toBeUndefined();
    expect(claudeStderrResumeRefusal("No conversation found with session ID: s-1 (after 3 turns)\n", "s-1")).toBeUndefined();
    expect(claudeStderrResumeRefusal("tool said: see No conversation found with session ID: s-1\n", "s-1")).toBeUndefined();
    expect(claudeStderrResumeRefusal("", "s-1")).toBeUndefined();
  });

  it("never resends a tracked turn whose dispatch is unverified, whatever the provider error", () => {
    const turn = { endedBeforeTurn: true, exitCode: 5, transient: true, streamed: false, answered: false, attempt: 0 };
    expect(mayResendTurn(turn)).toBe(true);
    expect(mayResendTurn({ ...turn, unverifiedDispatch: true })).toBe(false);
    expect(mayResendTurn({ ...turn, endedBeforeTurn: false, unverifiedDispatch: true })).toBe(false);
  });
});

describe("state B: a recorded dispatch or action", () => {
  it.each(["dispatched", "unknown", "confirmed"] as const)("blocks replay after an effect that is %s", (status) => {
    submitted();
    expect(ledger.reserveAction(ref, "tool:1", "effect")).toBe(true);
    expect(ledger.actionState(ref, "tool:1", "dispatched")).toBe(true);
    if (status === "unknown") expect(ledger.actionState(ref, "tool:1", "unknown")).toBe(true);
    if (status === "confirmed") expect(ledger.actionReceipt(ref, "tool:1", "completed", "provider-event")).toBe(true);
    // Even a later refusal frame cannot launder the recorded action into state A.
    ledger.finish(ref, "failed", "confirmed:no-dispatch");
    expect(ledger.positiveEvidence(ref)).toBe(false);
    expect(guard()).toBeUndefined();
    expect(audit().decisions[0]).toMatchObject({ decision: "action-requires-reconciliation" });
    expect(audit().attempts).toHaveLength(1);
  });

  it("blocks a reused request whose turn already dispatched a tool", () => {
    submitted();
    expect(ledger.authorizeNativeAction(ref, "tool:1", "effect", ["Bash", {}])).toBe(true);
    expect(() => requireReplayAdmission({}, false, ledger.hasDispatchedForRequest(scope.threadId, "request-message"), scope.threadId))
      .toThrow(/Replay was blocked/);
  });
});

describe("state C: missing, unknown or inconsistent history", () => {
  it("does not read a missing tool record as proof nothing ran", () => {
    const events = createReplayEvents(ledger);
    submitted();
    events.begin(scope.threadId, ref, model.configuredInstance);
    events.submitted(scope.threadId, false);
    events.finish(scope.threadId, "failed");
    expect(audit().actions).toHaveLength(0);
    expect(ledger.positiveEvidence(ref)).toBe(false);
    expect(guard()).toBeUndefined();
    expect(audit()).toMatchObject({ attempts: [{ outcome: "interrupted", evidence: "uncertain" }], decisions: [{ decision: "no-positive-evidence" }] });
  });

  it("blocks a turn a restart cut after submission and keeps it for reconciliation", () => {
    submitted();
    ledger.reconcileInterrupted();
    expect(guard()).toBeUndefined();
    expect(audit().attempts).toMatchObject([{ outcome: "interrupted", evidence: "uncertain" }]);
  });

  it("blocks an unknown task, a stale generation and a changed scope", () => {
    expect(ledger.replayGuard("never-recorded", "g", "startup-refusal", scope)).toBeUndefined();
    submitted();
    ledger.finish(ref, "failed", "confirmed:no-dispatch");
    expect(ledger.replayGuard(ref.logicalTaskId, "stale", "startup-refusal", scope)).toBeUndefined();
    expect(ledger.replayGuard(ref.logicalTaskId, ref.generation, "startup-refusal", { ...scope, approval: "full" })).toBeUndefined();
    expect(audit().decisions.map((row: any) => row.decision)).toEqual(["missing-evidence", "missing-evidence", "scope-changed"]);
  });

  it("blocks every recovery flag without an admitted replay", () => {
    for (const opts of [{ peerLimitResent: true }, { automaticRecoveryAttempted: true }, { automaticRecoveryIndex: 0 },
      { recoveringCoordination: true }, { computerSelectionContinuation: true }]) {
      expect(() => requireReplayAdmission(opts)).toThrow(/Replay was blocked/);
      // A continuation claim admits only a continuation, never another recovery path.
      if (!opts.computerSelectionContinuation) expect(() => requireReplayAdmission(opts, false, false, undefined, true)).toThrow(/Replay was blocked/);
    }
  });
});

describe("Auto-VM continuation", () => {
  function completed(actions: Array<"confirmed" | "unknown" | "dispatched"> = []) {
    submitted();
    actions.forEach((status, index) => {
      const id = `bridge:${index}`;
      expect(ledger.reserveAction(ref, id, "effect")).toBe(true);
      expect(ledger.actionState(ref, id, "dispatched")).toBe(true);
      if (status === "unknown") ledger.actionState(ref, id, "unknown");
      if (status === "confirmed") ledger.actionReceipt(ref, id, "completed", "bridge-response");
    });
    ledger.finish(ref, "complete", "uncertain");
  }

  it("admits a completed selecting turn whose every action has a receipt, once", () => {
    completed(["confirmed", "confirmed"]);
    const token = ledger.claimContinuation(ref, scope.threadId)!;
    expect(token).toBeTruthy();
    expect(ledger.claimContinuation(ref, scope.threadId)).toBeUndefined();
    expect(() => requireReplayAdmission({ computerSelectionContinuation: true }, true, true, scope.threadId, ledger.consumeContinuation(ref, token))).not.toThrow();
    expect(ledger.consumeContinuation(ref, token)).toBe(false);
    expect(() => requireReplayAdmission({ computerSelectionContinuation: true }, true, true, scope.threadId, ledger.consumeContinuation(ref, token)))
      .toThrow(/Replay was blocked/);
    expect(audit().decisions.map((row: any) => row.decision)).toEqual(["admitted", "superseded"]);
  });

  it.each([
    ["an unknown action", ["confirmed", "unknown"], "complete", "action-requires-reconciliation"],
    ["an action with no receipt", ["dispatched"], "complete", "action-requires-reconciliation"],
    ["a failed selecting turn", [], "failed", "no-positive-evidence"],
    ["an interrupted selecting turn", [], "interrupted", "no-positive-evidence"],
  ] as const)("refuses %s", (_name, actions, outcome, decision) => {
    submitted();
    actions.forEach((status, index) => {
      ledger.reserveAction(ref, `a${index}`, "effect");
      ledger.actionState(ref, `a${index}`, "dispatched");
      if (status === "unknown") ledger.actionState(ref, `a${index}`, "unknown");
      if (status === "confirmed") ledger.actionReceipt(ref, `a${index}`, "completed", "bridge-response");
    });
    ledger.finish(ref, outcome, "uncertain");
    expect(ledger.claimContinuation(ref, scope.threadId)).toBeUndefined();
    expect(audit().decisions[0]).toMatchObject({ site: "computer-continuation", decision });
  });

  it("refuses a pending turn, a wrong conversation, a missing turn and a turn a newer one superseded", () => {
    submitted();
    expect(ledger.claimContinuation(ref, scope.threadId)).toBeUndefined();
    ledger.finish(ref, "complete", "uncertain");
    expect(ledger.claimContinuation(ref, "other-thread")).toBeUndefined();
    expect(ledger.claimContinuation({ logicalTaskId: "missing", generation: "g" }, scope.threadId)).toBeUndefined();
    const newer = { logicalTaskId: "newer", generation: "n1" };
    expect(ledger.begin(newer, scope, model)).toBe(true);
    expect(ledger.claimContinuation(ref, scope.threadId)).toBeUndefined();
    expect(audit().decisions.map((row: any) => row.decision))
      .toEqual(["no-positive-evidence", "missing-evidence", "missing-evidence", "superseded"]);
  });

  it("lets only one of two concurrent processes claim the same continuation", async () => {
    completed(["confirmed"]);
    const claim = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import {createReplayLedger} from ${JSON.stringify(ledgerModule)};
        process.stdout.write(createReplayLedger(${JSON.stringify(file)}).claimContinuation(${JSON.stringify(ref)}, ${JSON.stringify(scope.threadId)}) ? "claimed" : "blocked");`],
      { stdio: ["ignore", "pipe", "inherit"] });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.on("error", reject).on("close", code => { if (code === 0) resolve(output); else reject(new Error(`child exit ${code}`)); });
    });
    expect((await Promise.all([claim(), claim(), claim()])).sort()).toEqual(["blocked", "blocked", "claimed"]);
  });

  it("does not let a continuation claim reopen a restart replay of the same turn", () => {
    completed(["confirmed"]);
    expect(ledger.claimContinuation(ref, scope.threadId)).toBeTruthy();
    expect(guard()).toBeUndefined();
  });
});
