import { newId, TurnNotStartedError, type ProviderAdapter, type ProviderInstance, type SendTurnInput, type TurnExecutionContext } from "./contracts.ts";
import type { OfficeControl, OfficeControlLease } from "./office-control.ts";

export type OfficeExecutionControl = Pick<OfficeControl, "prepare" | "invalidate">;
export type OfficeExecutionResolver = () => OfficeExecutionControl | undefined;
type Outcome = "completed" | "failed" | "cancelled";
interface Attempt {
  input: SendTurnInput;
  controller: AbortController;
  control: OfficeExecutionControl;
  lease?: OfficeControlLease;
  context?: TurnExecutionContext;
  turnId?: string;
  done: boolean;
  invoked: boolean;
  consumed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stop?: Promise<void>;
  detach?: () => void;
}

function stopped(): TurnNotStartedError {
  return new TurnNotStartedError(newId(), "Office execution was stopped or cancelled before provider admission.");
}

/** Applied after every optional provider decorator; retained adapters lose admission when the instance is disposed. */
export function withOfficeExecution(instance: ProviderInstance, resolve: OfficeExecutionResolver): ProviderInstance {
  const adapter = instance.adapter;
  const dispose = instance.dispose.bind(instance);
  const attempts = new Map<string, Attempt>();
  let disposed = false;
  const retire = (attempt: Attempt, outcome: Outcome) => {
    if (attempt.done) return;
    attempt.done = true;
    clearTimeout(attempt.timer);
    attempt.detach?.();
    if (attempts.get(attempt.input.threadId) === attempt) attempts.delete(attempt.input.threadId);
    try { attempt.lease?.finish(outcome); } catch {}
  };
  const stop = (attempt: Attempt): Promise<void> => {
    if (attempt.stop) return attempt.stop;
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    attempt.stop = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const pending = attempt.stop;
    attempt.controller.abort();
    try {
      attempt.control.invalidate(attempt.lease ? { attemptId: attempt.lease.attemptId }
        : { botId: attempt.input.botId, threadId: attempt.input.threadId }, "Native execution stopped");
    } catch {}
    void (async () => {
      if (attempt.invoked) await adapter.interruptTurn(attempt.input.threadId, attempt.turnId);
      retire(attempt, "cancelled");
    })().then(complete, (error) => {
      try { attempt.lease?.finish("uncertain"); } catch {}
      attempt.stop = undefined;
      fail(error);
    });
    return pending;
  };
  const off = adapter.onEvent((event) => {
    const attempt = attempts.get(event.threadId);
    if (!attempt || attempt.done || !attempt.invoked) return;
    if (event.type === "turn.started" && !attempt.turnId) attempt.turnId = event.turnId;
    if (event.type !== "turn.completed" || !attempt.turnId || attempt.turnId !== event.turnId) return;
    retire(attempt, attempt.controller.signal.aborted ? "cancelled" : event.ok ? "completed" : "failed");
  });
  const wrapped: ProviderAdapter = {
    ...adapter,
    sendTurn: async (input) => {
      input = { ...input, toolScope: input.toolScope ? {
        ...(input.toolScope.allow === undefined ? {} : { allow: [...input.toolScope.allow] }),
        ...(input.toolScope.deny === undefined ? {} : { deny: [...input.toolScope.deny] }),
      } : undefined };
      if (disposed) throw new Error("This office provider was removed or disposed.");
      if (instance.driverKind !== "codex" || adapter.capabilities.engineAdmission !== true) {
        throw new Error("Office execution does not support this driver or native execution surface.");
      }
      if (!input.botId || !input.cwd) throw new Error("Office execution requires the native bot and working-directory binding.");
      if (attempts.has(input.threadId)) throw new Error("An office execution attempt is already active on this thread.");
      const control = resolve();
      if (!control) throw new Error("Office control is unavailable; provider execution remains closed.");
      const attempt: Attempt = { input, controller: new AbortController(), control, done: false, invoked: false, consumed: false };
      attempts.set(input.threadId, attempt);
      try {
        const preparing = control.prepare({ botId: input.botId, threadId: input.threadId, cwd: input.cwd,
          instanceId: instance.instanceId, driverKind: instance.driverKind, signal: attempt.controller.signal,
          model: input.model, effort: input.effort, variant: input.variant, approvalMode: input.approvalMode, toolScope: input.toolScope });
        let abortListener!: () => void;
        const cancelled = new Promise<never>((_done, reject) => {
          abortListener = () => reject(stopped());
          attempt.controller.signal.addEventListener("abort", abortListener, { once: true });
          if (attempt.controller.signal.aborted) abortListener();
        });
        preparing.then((lease) => {
          if (attempt.done || attempt.controller.signal.aborted) { try { lease.finish("cancelled"); } catch {} }
        }, () => {});
        let lease: OfficeControlLease;
        try { lease = await Promise.race([preparing, cancelled]); }
        finally { attempt.controller.signal.removeEventListener("abort", abortListener); }
        attempt.lease = lease;
        if (disposed || attempt.done || attempt.controller.signal.aborted) throw stopped();
        if (!lease || typeof lease.attemptId !== "string" || !lease.attemptId || !lease.signal
          || typeof lease.assert !== "function" || typeof lease.finish !== "function"
          || !Number.isSafeInteger(lease.rootDeadline) || !Number.isSafeInteger(lease.expiresAt)
          || lease.kind !== "work" || Math.min(lease.rootDeadline, lease.expiresAt) <= Date.now()) {
          throw new Error("Office execution lease or deadline is invalid; this execution surface is closed.");
        }
        const deadline = Math.min(lease.rootDeadline, lease.expiresAt);
        let processStarted = false;
        const context: TurnExecutionContext = {
          attemptId: lease.attemptId, signal: attempt.controller.signal, deadline,
          assert: (stage) => {
            if (disposed || attempt.done || attempts.get(input.threadId) !== attempt
              || attempt.controller.signal.aborted || lease.signal.aborted || Date.now() >= deadline) throw stopped();
            if ((stage === "process" && processStarted) || (stage !== "process" && !processStarted)) {
              throw new Error("Office execution requires one native process for this exact attempt.");
            }
            lease.assert(stage);
            if (stage === "process") attempt.consumed = true;
            if (attempt.controller.signal.aborted || lease.signal.aborted || Date.now() >= deadline) throw stopped();
            if (stage === "process") processStarted = true;
          },
        };
        attempt.context = context;
        const revoked = () => { void stop(attempt).catch(() => {}); };
        lease.signal.addEventListener("abort", revoked, { once: true });
        attempt.detach = () => lease.signal.removeEventListener("abort", revoked);
        attempt.timer = setTimeout(revoked, Math.min(deadline - Date.now(), 2_147_483_647));
        attempt.timer.unref?.();
        if (lease.signal.aborted) throw stopped();
        attempt.invoked = true;
        const result = await adapter.sendTurn({ ...input, executionContext: context });
        if (!attempt.done) attempt.turnId = result.turnId;
        if (attempt.controller.signal.aborted) { await stop(attempt); throw stopped(); }
        return result;
      } catch (error) {
        if (attempt.consumed || attempt.controller.signal.aborted) {
          try { await stop(attempt); } catch { throw error; }
        }
        retire(attempt, attempt.controller.signal.aborted ? "cancelled" : "failed");
        throw error;
      }
    },
    interruptTurn: async (threadId, turnId) => {
      const attempt = attempts.get(threadId);
      if (!attempt || (turnId !== undefined && attempt.turnId !== turnId)) return;
      await stop(attempt);
    },
    stopAll: async () => {
      const results = await Promise.allSettled([...attempts.values()].map(stop));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await adapter.stopAll();
    },
    steer: adapter.steer ? async (threadId, text, images) => {
      const attempt = attempts.get(threadId);
      if (!attempt?.lease || !attempt.turnId || attempt.done || attempt.controller.signal.aborted || attempt.lease.signal.aborted) return "refused";
      try {
        if (Date.now() >= Math.min(attempt.lease.rootDeadline, attempt.lease.expiresAt)) return "refused";
        attempt.context!.assert("steer");
      } catch { return "refused"; }
      return adapter.steer!(threadId, text, images);
    } : undefined,
    respondToRequest: async (threadId, requestId, decision) => {
      if (decision.behavior !== "deny") {
        const attempt = attempts.get(threadId);
        if (!attempt?.lease || !attempt.turnId || attempt.done || attempt.controller.signal.aborted || attempt.lease.signal.aborted
          || Date.now() >= Math.min(attempt.lease.rootDeadline, attempt.lease.expiresAt)) return "unavailable";
        try { attempt.context!.assert("steer"); } catch { return "unavailable"; }
      }
      return adapter.respondToRequest(threadId, requestId, decision);
    },
    cacheKeepWarm: adapter.cacheKeepWarm ? {
      ping: async () => ({ ok: false, reason: "Office execution disables unrequested background model calls." }),
      hold: () => false,
    } : undefined,
  };
  (instance as { adapter: ProviderAdapter }).adapter = wrapped;
  delete instance.generateText;
  delete instance.generateMemoryText;
  delete instance.reviewPermission;
  instance.dispose = async () => {
    disposed = true;
    const results = await Promise.allSettled([...attempts.values()].map(stop));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    off();
    await dispose();
  };
  return instance;
}
