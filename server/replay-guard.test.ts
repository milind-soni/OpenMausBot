import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startupBackups } from "./automatic-recovery.ts";
import { quotaSwitchEnabled, turnLimitScope } from "./quota-switch.ts";
import { createReplayLedger, requireReplayAdmission, type ReplayRef, type ReplayScope, type ReplaySite } from "./replay-guard.ts";
import { createReplayEvents } from "./replay-events.ts";
import { readReplayAudit } from "./testing/replay-audit.ts";

const ref: ReplayRef = { logicalTaskId: "task", generation: "request-1" };
const scope: ReplayScope = { owner: "owner", threadId: "thread", approval: "ask", tools: ["native:Read"], workspace: "/fixture", authority: { principal: "fixture-secret-value" } };
const model = { configuredInstance: "primary", configuredModel: "configured", requestId: "request-message" };
const ledgerModule = new URL("./replay-guard.ts", import.meta.url).href;
let dir: string;
let file: string;
let ledger: ReturnType<typeof createReplayLedger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-gate-"));
  file = join(dir, "replay-safety.db");
  ledger = createReplayLedger(file);
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const audit = () => readReplayAudit(dir);
const guard = (site: ReplaySite, source = ref, currentScope = scope) =>
  ledger.replayGuard(source.logicalTaskId, source.generation, site, currentScope);
function begin() {
  expect(ledger.begin(ref, scope, model)).toBe(true);
  expect(ledger.markSubmitted(ref, { scope })).toBe(true);
}
function proven() { expect(ledger.finish(ref, "failed", "confirmed:no-dispatch", "engine")).toBe(true); }
function effect(id: string) {
  expect(ledger.authorizeNativeAction(ref, id, "effect", ["tool", "fixture-secret-value"])).toBe(true);
}

describe("replay safety matrix", () => {
  it("01 direct pre-work quota admits one backup with independent serving-model attribution", () => {
    begin();
    proven();
    const next = guard("direct-quota")!;
    expect(ledger.begin(next, scope, { configuredInstance: "backup", configuredModel: "selection" })).toBe(true);
    expect(ledger.markSubmitted(next, { scope })).toBe(true);
    expect(audit().attempts[1]).toMatchObject({ configuredModel: "selection", servingModel: "unknown" });
    ledger.servingModel(next, "provider-reported-model");
    ledger.finish(next, "complete", "uncertain");
    expect(audit().attempts[1]).toMatchObject({ configuredModel: "selection", servingModel: "provider-reported-model", outcome: "complete" });
  });

  it.each([[2, "peer-limit"], [3, "startup-refusal"]] as const)("%s %s admits pre-work failure with the same request and scope", (_number, site) => {
    expect(ledger.begin(ref, scope, model)).toBe(true);
    proven();
    const replay = guard(site);
    expect(replay).toMatchObject({ logicalTaskId: ref.logicalTaskId });
    expect(ledger.begin(replay!, scope, model)).toBe(true);
    expect(ledger.begin(replay!, scope, model)).toBe(false);
  });

  it("04 ordinary and tool-origin failures cannot qualify even when tool words or flags mention quota", () => {
    expect(turnLimitScope({ stopReason: "tool_error" } as never, { limit: "engine" }, "weekly usage limit")).toBeUndefined();
    expect(turnLimitScope({ stopReason: "error" } as never, undefined, "ordinary failure")).toBeUndefined();
    begin();
    ledger.finish(ref, "failed", "uncertain");
    expect(guard("direct-quota")).toBeUndefined();
  });

  it("05 confirmed read interrupts the original task and does not admit replay", () => {
    begin();
    expect(ledger.authorizeNativeAction(ref, "read-1", "read", ["Read", { file_path: "synthetic" }])).toBe(true);
    expect(ledger.actionReceipt(ref, "read-1", "completed", "native-hook")).toBe(true);
    proven();
    expect(ledger.positiveEvidence(ref)).toBe(false);
    expect(guard("direct-quota")).toBeUndefined();
    expect(audit()).toMatchObject({ attempts: [{ outcome: "interrupted", evidence: "uncertain" }], actions: [{ status: "confirmed", receipt: "completed" }] });
  });

  it.each([[6, "confirmed"], [7, "unknown"]] as const)("%s external write with %s result interrupts without replay", (_number, status) => {
    begin();
    effect("side-effect");
    if (status === "confirmed") expect(ledger.actionReceipt(ref, "side-effect", "completed", "native-hook")).toBe(true);
    proven();
    expect(guard("direct-quota")).toBeUndefined();
    expect(audit()).toMatchObject({
      attempts: [{ outcome: "interrupted" }], actions: [{ status }],
      decisions: [{ decision: "action-requires-reconciliation" }],
    });
    if (status === "unknown") {
      expect(ledger.actionReceipt(ref, "side-effect", "failed", "native-hook")).toBe(true);
      expect(audit().actions[0]).toMatchObject({ status: "confirmed", receipt: "failed" });
      expect(guard("chief-retry")).toBeUndefined();
    }
  });

  it("08 process dies between dispatch and receipt, then the restarted ledger forbids replay", () => {
    const script = `import {createReplayLedger} from ${JSON.stringify(ledgerModule)};
      const db = createReplayLedger(${JSON.stringify(file)});
      const ref = ${JSON.stringify(ref)};
      db.begin(ref, ${JSON.stringify(scope)}, ${JSON.stringify(model)});
      db.markSubmitted(ref, {});
      db.authorizeNativeAction(ref, "effect", "effect", {});
      process.kill(process.pid, "SIGKILL");`;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" })).toThrow(expect.objectContaining({ signal: "SIGKILL" }));
    ledger.close();
    ledger = createReplayLedger(file);
    ledger.reconcileInterrupted();
    expect(guard("routine-recovery")).toBeUndefined();
    expect(audit()).toMatchObject({ attempts: [{ outcome: "interrupted" }], actions: [{ status: "unknown" }] });
  });

  it.each(["failed", "restarted"] as const)("admits a %s preparation once with no provider submission", (reason) => {
    expect(ledger.begin(ref, scope, model)).toBe(true);
    if (reason === "failed") ledger.finish(ref, "failed", "uncertain");
    else ledger.reconcileInterrupted();
    expect(ledger.positiveEvidence(ref)).toBe(true);
    expect(guard("routine-recovery")).toBeDefined();
    expect(guard("routine-recovery")).toBeUndefined();
  });

  it("keeps a restarted preparation with a recorded read blocked", () => {
    expect(ledger.begin(ref, scope, model)).toBe(true);
    expect(ledger.authorizeNativeAction(ref, "read", "read", ["Read", {}])).toBe(true);
    ledger.reconcileInterrupted();
    expect(ledger.positiveEvidence(ref)).toBe(false);
    expect(guard("routine-recovery")).toBeUndefined();
    expect(audit().actions).toMatchObject([{ kind: "read", status: "unknown" }]);
  });

  it("09 quick fallback and Chief retry race in different processes and one wins", async () => {
    begin();
    proven();
    const run = (site: ReplaySite) => new Promise<string>((resolve, reject) => {
      const args = [ref.logicalTaskId, ref.generation, site, scope].map(value => JSON.stringify(value)).join(",");
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import {createReplayLedger} from ${JSON.stringify(ledgerModule)};
        process.stdout.write(createReplayLedger(${JSON.stringify(file)}).replayGuard(${args}) ? "admitted" : "blocked");`], { stdio: ["ignore", "pipe", "inherit"] });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.on("error", reject).on("close", code => { if (code === 0) resolve(output); else reject(new Error(`child exit ${code}`)); });
    });
    expect((await Promise.all([run("quick-model"), run("chief-retry")])).sort()).toEqual(["admitted", "blocked"]);
    expect(audit().attempts).toHaveLength(2);
  });

  it("10 card and held generations cannot replay after a fresh authorized request", () => {
    begin();
    proven();
    const fresh = { logicalTaskId: "fresh-task", generation: "fresh-generation" };
    expect(ledger.begin(fresh, scope, model)).toBe(true);
    expect(guard("quota-card")).toBeUndefined();
    expect(guard("held-request")).toBeUndefined();
    expect(audit().decisions.every(row => row.decision === "superseded")).toBe(true);
    expect(ledger.markSubmitted(fresh, { scope })).toBe(true);
  });

  it("11 per-bot backups and app recovery are independent; changed scope blocks and logs omit private inputs", () => {
    const backup = [{ instanceId: "b", model: "synthetic" }];
    for (const enabled of [false, true]) expect(startupBackups({ fallback: backup }, { enabled })).toEqual(backup);
    expect(quotaSwitchEnabled({ OMB_QUOTA_SWITCH: "0" })).toBe(false);
    expect(startupBackups({ fallback: [] }, { enabled: false })).toEqual([]);
    expect(startupBackups({ fallback: [] }, { enabled: true, backup: backup[0] })).toEqual(backup);
    begin();
    proven();
    expect(guard("startup-refusal", ref, { ...scope, approval: "full", tools: ["native:*"], workspace: "/other" })).toBeUndefined();
    expect(audit().decisions[0]).toMatchObject({ decision: "scope-changed" });
    expect(readFileSync(file).includes(Buffer.from("fixture-secret-value"))).toBe(false);
  });

  it("duplicate terminal events cannot resurrect an interrupted attempt and delayed approvals cannot act", () => {
    const events = createReplayEvents(ledger);
    begin();
    events.begin(scope.threadId, ref, model.configuredInstance);
    const event = { eventId: "approval", createdAt: new Date().toISOString(), type: "request.opened",
      requestType: "permission", tool: "Write", threadId: scope.threadId, turnId: "t1", requestId: "approval1", summary: "private",
      provider: "claudeAgent", providerInstanceId: model.configuredInstance } as const;
    events.observe(event);
    expect(events.approvalIsCurrent(scope.threadId, "approval1")).toBe(true);
    events.finish(scope.threadId, "interrupted");
    expect(events.finish(scope.threadId, "complete")).toBe(false);
    expect(events.approvalIsCurrent(scope.threadId, "approval1")).toBe(false);
    expect(events.duplicateTerminal({ ...event, type: "turn.completed", ok: true })).toBe(true);
    expect(audit().attempts[0]).toMatchObject({ outcome: "interrupted" });
  });
});


describe("fail-closed dispatch boundaries", () => {
  it("requires a durable ticket for redispatch, including reused requests and both computer continuations", () => {
    begin();
    expect(ledger.hasRequest(scope.threadId, "request-message")).toBe(true);
    for (const opts of [{ peerLimitResent: true }, { automaticRecoveryIndex: 1 }, { computerSelectionContinuation: true },
      { recoveringCoordination: true }]) {
      expect(() => requireReplayAdmission(opts)).toThrow(/Replay was blocked/);
    }
    expect(() => requireReplayAdmission({}, ledger.hasRequest(scope.threadId, "request-message"))).toThrow(/Replay was blocked/);
    const fabricated = { logicalTaskId: "fabricated", generation: "fabricated" };
    expect(ledger.isAdmitted(fabricated, scope.threadId)).toBe(false);
    expect(ledger.begin(fabricated, scope, model, true)).toBe(false);
    expect(audit().attempts).toHaveLength(1);
    expect(() => requireReplayAdmission({})).not.toThrow();
  });

  it.each([
    ["one-on-one goal", { goalRunId: "goal", cardContinuation: true }],
    ["question card", { cardContinuation: true }],
    ["parked card", { cardContinuation: true, continuesRun: true }],
    ["spend-cap goal", { goalRunId: "goal", cardContinuation: true, continuesRun: true }],
    ["burst", { cardContinuation: true, allowRoomTurnElsewhere: true }],
    ["lending Allow", { cardContinuation: true, continuesRun: true }],
  ] as const)("allows the %s continuation before tool dispatch and blocks it after a recorded read", (_name, opts) => {
    const request = "request-message";
    begin();
    const dispatch = { ...opts, replay: undefined, requestMessageId: request };
    const admit = () => requireReplayAdmission(dispatch, false, ledger.hasDispatchedForRequest(scope.threadId, request));
    expect(admit).not.toThrow();
    expect(ledger.reserveAction(ref, "approval", "effect")).toBe(true);
    expect(admit).not.toThrow();
    expect(ledger.authorizeNativeAction(ref, "read", "read", ["Read", {}])).toBe(true);
    expect(ledger.actionState(ref, "read", "confirmed", "completed")).toBe(true);
    expect(admit).toThrow(/Replay was blocked/);
    expect(() => requireReplayAdmission(dispatch, false, ledger.hasDispatchedForRequest(scope.threadId, "fresh"))).not.toThrow();
  });

  it.each(["complete", "failed"] as const)("advances a goal only after a successful dispatched step (%s)", (outcome) => {
    const request = "request-message";
    begin();
    expect(ledger.authorizeNativeAction(ref, "read", "read", ["Read", {}])).toBe(true);
    expect(ledger.actionReceipt(ref, "read", "completed", "native-hook")).toBe(true);
    expect(ledger.finish(ref, outcome, "uncertain")).toBe(true);
    expect(ledger.hasDispatchedForRequest(scope.threadId, request)).toBe(true);
    expect(ledger.hasDispatchedForRequest(scope.threadId, request, true)).toBe(outcome === "failed");
  });

  it.each(["quick-model", "saved-steps"] as const)("blocks %s with no explicit refusal evidence", (site) => {
    const events = createReplayEvents(ledger);
    begin();
    events.begin(scope.threadId, ref, model.configuredInstance);
    events.submitted(scope.threadId, true);
    events.finish(scope.threadId, "failed");
    expect(guard(site)).toBeUndefined();
    expect(audit().decisions[0]).toMatchObject({ decision: "no-positive-evidence" });
  });

  it.each(["codex", "opencode", "antigravity", "claudeAgent"])("blocks an opaque %s attempt after submission even with a provider quota frame", (provider) => {
    const events = createReplayEvents(ledger);
    begin();
    events.begin(scope.threadId, ref, model.configuredInstance);
    events.submitted(scope.threadId, false);
    events.observe({ type: "turn.completed", eventId: "terminal", createdAt: new Date().toISOString(),
      threadId: scope.threadId, turnId: "t1", provider, providerInstanceId: model.configuredInstance,
      ok: false, stopReason: "quota", replayNoDispatch: true });
    events.finish(scope.threadId, "failed", undefined, "engine");
    expect(guard("direct-quota")).toBeUndefined();
    expect(audit().attempts[0]).toMatchObject({ outcome: "interrupted", evidence: "uncertain" });
  });
});


it("blocks a hookless Claude startup-refusal inference after submission", () => {
  const events = createReplayEvents(ledger);
  begin();
  events.begin(scope.threadId, ref, model.configuredInstance);
  events.submitted(scope.threadId, false);
  events.finish(scope.threadId, "failed", "guarded-startup-refusal", "engine");
  expect(guard("startup-refusal")).toBeUndefined();
  expect(audit().attempts[0]).toMatchObject({ outcome: "interrupted" });
});
