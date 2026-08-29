import { z } from "zod";

import type { Routine } from "./routines.ts";
import type { CreateObligationInput, WorkLockStoreInterface, WorkObligation } from "./work-lock-store.ts";

const MANAGER = "routine-work-lock";

type ManagedRoutineMetadata = {
  managedBy: typeof MANAGER;
  routineId: string;
  scheduledAt: number;
  runOn: Routine["runOn"];
};

const managedRoutineMetadataSchema = z.object({
  managedBy: z.literal(MANAGER),
  routineId: z.string(),
  scheduledAt: z.number(),
  runOn: z.enum(["maus", "cloud"]),
});

export type RoutineWorkLockSync =
  | { kind: "unchanged"; workLockId?: string }
  | { kind: "linked"; workLockId: string }
  | { kind: "cleared" };

function metadataFor(routine: Routine): ManagedRoutineMetadata {
  if (routine.schedule.type !== "once") throw new Error("Only one-time routines become obligations");
  return {
    managedBy: MANAGER,
    routineId: routine.id,
    scheduledAt: routine.schedule.at,
    runOn: routine.runOn,
  };
}

function managedMetadata(obligation: WorkObligation | null): ManagedRoutineMetadata | null {
  const parsed = managedRoutineMetadataSchema.safeParse(obligation?.metadata);
  return parsed.success ? parsed.data : null;
}

function stillOpen(obligation: WorkObligation): boolean {
  return obligation.status !== "completed" && obligation.status !== "cancelled";
}

/**
 * Project an enabled, future one-time routine into durable work state.
 *
 * Recurring automation is machinery, not an obligation. User-linked work is
 * never rewritten: this function only owns locks carrying its private marker.
 * A schedule edit retires the old managed lock and creates a new revision, so
 * a disabled/re-enabled reminder can never resurrect a terminal lock.
 */
export function synchronizeRoutineWorkLock(
  routine: Routine,
  workLocks: WorkLockStoreInterface,
  options: { now?: number; ownerLabel?: string } = {},
): RoutineWorkLockSync {
  const now = options.now ?? Date.now();
  const existing = routine.workLockId ? workLocks.getObligation(routine.workLockId) : null;
  const existingMetadata = managedMetadata(existing);
  const shouldOwnLock = routine.enabled && routine.schedule.type === "once" && routine.schedule.at > now;

  // An explicit user/package link is authoritative. The automatic projection
  // must not cancel, replace, or reinterpret it.
  if (existing && !existingMetadata) return { kind: "unchanged", workLockId: existing.id };

  if (existing && existingMetadata && shouldOwnLock && routine.schedule.type === "once") {
    if (existingMetadata.routineId === routine.id && existingMetadata.scheduledAt === routine.schedule.at) {
      return { kind: "unchanged", workLockId: existing.id };
    }
  }

  if (existing && existingMetadata && stillOpen(existing)) {
    workLocks.cancelObligation(existing.id, existing.version);
  }

  if (!shouldOwnLock || routine.schedule.type !== "once") {
    return routine.workLockId ? { kind: "cleared" } : { kind: "unchanged" };
  }

  const metadata = metadataFor(routine);
  const input: CreateObligationInput = {
    title: routine.name,
    description: routine.prompt,
    externalIdentity: {
      source: "routine",
      // updatedAt is a generation token. A re-enabled reminder with the same
      // timestamp gets a fresh lock instead of deduplicating to a cancelled one.
      id: `${routine.id}:${routine.schedule.at}:${routine.updatedAt}`,
    },
    ownerId: routine.botId,
    metadata,
    deadline: {
      key: "scheduled-run",
      label: routine.name,
      dueAt: routine.schedule.at,
    },
  };
  if (options.ownerLabel) input.ownerLabel = options.ownerLabel;
  const created = workLocks.createObligation(input);
  return { kind: "linked", workLockId: created.obligation.id };
}
