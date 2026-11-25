import { handedStateUsable, unseenMessages, type ContextMessage, type HandedState } from "./delta-context.ts";
import { canResume, engineIsFresh } from "./turn-context.ts";

export interface ResumePlanInput {
  task: { resumeCursors: Record<string, unknown>; lastInstanceId?: string; handedMessages?: Record<string, HandedState>; rewound?: boolean; appliedCompactionId?: string };
  instanceId: string;
  strictResume: boolean;
  compacted: number;
  recordId: string | undefined;
  folderChanged: boolean;
  contextOrder: readonly string[];
  replayable: Array<ContextMessage>;
  externalMarker: string | undefined;
  coordinationResumed: boolean;
  effort: string | undefined;
}

export function resumePlan(input: ResumePlanInput) {
  const { task, instanceId, externalMarker } = input;
  const contextReset = input.compacted > 0 && input.recordId !== task.appliedCompactionId;
  const cursors = contextReset || input.folderChanged ? {} : task.resumeCursors;
  const rewound = Boolean(task.rewound);
  const fresh = !rewound && !externalMarker && engineIsFresh({ instanceId, lastInstanceId: task.lastInstanceId, resumeCursors: cursors, transcript: input.replayable });
  const cursor = cursors[instanceId];
  const handed = input.strictResume && !rewound && !contextReset && !fresh && !externalMarker && cursor !== undefined ? task.handedMessages?.[instanceId] : undefined;
  const unseen = handed && handedStateUsable(handed, cursor, input.contextOrder) ? unseenMessages(input.replayable, input.contextOrder, handed) : undefined;
  const externalUpdate = Boolean(input.coordinationResumed || unseen?.some((m) => m.keep));
  /** A Codex thread keeps the last effort it was sent and no turn can clear it, so one holding a level is rebuilt, not resumed. */
  const stale = (config: string): boolean => {
    const effortHeld = !input.effort && typeof handed?.effort === "string";
    return Boolean(handed && (!unseen || effortHeld || (externalUpdate && handed.config !== config)));
  };
  return {
    contextReset, rewound, fresh, cursor, handed, unseen, externalUpdate, stale,
    resumes: (config: string): boolean => canResume({ rewound, fresh: fresh || contextReset, externallyUpdated: Boolean(externalMarker) || stale(config) }),
  };
}
