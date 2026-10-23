import type { TaskRecord } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";
import type { WireTask } from "../shared/wire.ts";

 export function toWireTask(task: TaskRecord, botModel: ModelSelection): WireTask {
  const { resumeCursors: _resumeCursors, lastInstanceId: _lastInstanceId, handedMessages: _handedMessages,
    appliedCompactionId: _appliedCompactionId, contextFloor: _contextFloor, lastContextModel: _lastContextModel,
    surfaceSource, askedAt: _askedAt, ...stored } = task;
  const wire: WireTask = { ...stored, modelSelection: structuredClone(task.modelSelection ?? botModel), followsBotModel: task.modelSelection === undefined };
  return surfaceSource === "auto" && wire.surface !== undefined ? { ...wire, surfaceAuto: true } : wire;
}
