import { toWireTask, type TaskRecord } from "./store.ts";
import type { WireTask } from "../shared/wire.ts";

/** Wire view of a task: the shared wire shape plus the coordination wait
 * flag below. */
export type WiredTask = WireTask & { waitingOnTeammate?: true };

/** True while this thread has handed work to a teammate that has not
 * settled yet (a live direct coordination handoff). */
export type ActiveCoordination = (threadId: string) => boolean;

/** Strip the harness's own session bookkeeping and surface the
 * coordination wait as a flag on top of the busy paint (#1223).
 *
 * A thread waiting on a dispatched teammate is not working on its own
 * turn, but wait clients settle when busy clears, so the paint must stay
 * or wait_for_conversation returns on partial state. The flag says which
 * busy is really a wait, so clients that know it show a quiet wait. */
export const wireTaskFor =
  (isActiveCoordination: ActiveCoordination) =>
  (task: TaskRecord): WiredTask =>
    isActiveCoordination(task.threadId) && !task.busy ? { ...toWireTask(task), busy: true, activity: "working" as const, waitingOnTeammate: true } : toWireTask(task);
