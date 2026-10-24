import type { JobCancellationResult, JobCancellationSnapshot } from "../shared/job-cancellation.ts";
import { z } from "zod";
import { requestConflict } from "./guarded-requests.ts";

export interface NativeJobCancellationSnapshot {
  rootId: string;
  sourceBotId: string;
  sourceThreadId: string;
  requestMessageId?: string;
  generation: string;
  treeVersion: string;
  assignments: Array<{ id: string; botId: string; threadId: string; status: string; executions: number; generation?: string; attemptId?: string; attemptState?: string; attemptConsumedAt?: number; attemptFinishedAt?: number }>;
}

interface JobCancellationDeps {
  native(rootId: string): NativeJobCancellationSnapshot | undefined;
  authorize(chiefId: string, native: NativeJobCancellationSnapshot): void;
  source(native: NativeJobCancellationSnapshot): Pick<JobCancellationSnapshot, "activeLeafId" | "activeTurnId" | "executionId">;
  cancelNative(rootId: string, expectedTreeVersion: string, reason: string): boolean;
  markCancelled(threadId: string, messageId: string): void;
  receipt(threadId: string, messageId: string): JobCancellationResult | undefined;
  saveReceipt(threadId: string, messageId: string, result: JobCancellationResult): void;
  interruptExact(botId: string, threadId: string, generation: string, reason: string): Promise<void>;
}

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled";
export const nativeJobExecutionUnconfirmed = (assignment: NativeJobCancellationSnapshot["assignments"][number]) =>
  assignment.attemptState === "uncertain" || ((assignment.attemptState === "consumed" || assignment.attemptConsumedAt !== undefined) && assignment.attemptFinishedAt === undefined);
const REASON = "Cancelled by the person";
const id = z.string().regex(/^[\w-]{1,128}$/);
export const jobCancellationSnapshotSchema = z.object({
  rootId: id, sourceBotId: id, sourceThreadId: id, requestMessageId: id, generation: id,
  treeVersion: z.string().min(1).max(256), activeLeafId: id.nullable(),
  activeTurnId: z.string().min(1).max(200).nullable(), executionId: id.nullable(),
}).strict();

export function createJobCancellation(deps: JobCancellationDeps) {
  const read = (chiefId: string, rootId: string) => {
    const native = deps.native(rootId);
    if (!native || native.sourceBotId !== chiefId) throw Object.assign(new Error("No such Chief job"), { status: 404 });
    deps.authorize(chiefId, native);
    if (!native.requestMessageId) throw requestConflict("This job has no proven source request; open its conversation");
    return native as NativeJobCancellationSnapshot & { requestMessageId: string };
  };
  const snapshot = (chiefId: string, rootId: string): JobCancellationSnapshot => {
    const native = read(chiefId, rootId);
    return { rootId: native.rootId, sourceBotId: native.sourceBotId, sourceThreadId: native.sourceThreadId,
      requestMessageId: native.requestMessageId, generation: native.generation, treeVersion: native.treeVersion, ...deps.source(native) };
  };
  const result = (native: NativeJobCancellationSnapshot, errors: string[] = []): JobCancellationResult => {
    const activeIds = native.assignments.filter(a => !terminal(a.status) || nativeJobExecutionUnconfirmed(a)).map(a => a.id);
    if (native.assignments.some(nativeJobExecutionUnconfirmed)) errors = [...new Set([...errors, "A native execution has no confirmed local stop"])];
    return { rootId: native.rootId, state: activeIds.length || errors.length ? "partial" : "cancelled",
      stoppedIds: native.assignments.filter(a => a.status === "cancelled" && !activeIds.includes(a.id)).map(a => a.id), activeIds, errors };
  };
  return {
    snapshot,
    async cancel(chiefId: string, expected: JobCancellationSnapshot): Promise<JobCancellationResult> {
      const native = read(chiefId, expected.rootId);
      if (native.sourceThreadId !== expected.sourceThreadId || native.sourceBotId !== expected.sourceBotId ||
          native.requestMessageId !== expected.requestMessageId || native.generation !== expected.generation) throw requestConflict();
      if (native.assignments.every(a => terminal(a.status)) && native.assignments.some(nativeJobExecutionUnconfirmed)) {
        return { ...result(native), ...(native.assignments.find(a => a.id === native.rootId)?.status === "cancelled" ? { alreadyCancelled: true } : {}) };
      }
      if (native.assignments.find(a => a.id === native.rootId)?.status === "cancelled" && native.assignments.every(a => terminal(a.status))) {
        const receipt = deps.receipt(native.sourceThreadId, native.requestMessageId);
        return { ...(receipt?.rootId === native.rootId ? receipt : result(native, ["Cancellation is recorded; local interruption confirmation is unavailable"])), alreadyCancelled: true };
      }
      const current = deps.source(native);
      if (native.treeVersion !== expected.treeVersion || current.activeLeafId !== expected.activeLeafId ||
          current.activeTurnId !== expected.activeTurnId || current.executionId !== expected.executionId) throw requestConflict();
      if (native.assignments.every(a => terminal(a.status))) throw requestConflict("This job has already settled");
      // No await between the final ownership/tree check and revoking the native execution tree.
      deps.authorize(chiefId, native);
      if (!deps.cancelNative(native.rootId, native.treeVersion, REASON)) throw requestConflict();
      const errors: string[] = [];
      try { deps.markCancelled(native.sourceThreadId, native.requestMessageId); }
      catch { errors.push("The source request could not record cancellation"); }
      const interruptions = await Promise.allSettled(native.assignments.map(assignment => deps.interruptExact(
        assignment.botId, assignment.threadId, assignment.generation ?? assignment.id, REASON)));
      const unconfirmedIds = interruptions.flatMap((interruption, index) => interruption.status === "rejected" ? [native.assignments[index]!.id] : []);
      if (unconfirmedIds.length) errors.push("A local turn could not confirm interruption");
      const after = deps.native(native.rootId);
      const outcome: JobCancellationResult = after ? result(after, errors) : { rootId: native.rootId, state: "partial", stoppedIds: [], activeIds: [],
        errors: [...errors, "The native job could not be read after cancellation"] };
      outcome.activeIds = [...new Set([...outcome.activeIds, ...unconfirmedIds])];
      outcome.stoppedIds = outcome.stoppedIds.filter(id => !unconfirmedIds.includes(id));
      try { deps.saveReceipt(native.sourceThreadId, native.requestMessageId, outcome); }
      catch { outcome.state = "partial"; outcome.errors.push("The cancellation receipt could not be saved"); }
      return outcome;
    },
  };
}
