import { approvalModeFor, approvalModeWidens, type ApprovalFields } from "../shared/approval-mode.ts";
import { registrySaveFailure, type RegistryFile } from "../shared/registry-save-failure.ts";
import type { TaskPatch } from "./store.ts";

export class RegistrySaveError extends Error {
  constructor(action: string, file: RegistryFile, cause: unknown) {
    super(registrySaveFailure(action, file, (cause as { code?: unknown } | null)?.code), { cause });
  }
}

export function saveRegistryFor(file: RegistryFile, action: string, save: () => void): void {
  try { save(); } catch (error) { throw new RegistrySaveError(action, file, error); }
}

/** Memory changes only once the file holds them; a failed save restores the record and its threads in place. */
export function commitRegistryChange(record: { tasks?: object[] }, file: RegistryFile, action: string, save: () => void,
  change: () => void, onRollback?: () => void): void {
  const rollback = snapshot(record);
  change();
  try { save(); } catch (error) {
    rollback();
    onRollback?.();
    throw new RegistrySaveError(action, file, error);
  }
}

function snapshot(record: { tasks?: object[] }): () => void {
  const { tasks, ...fields } = record;
  const saved = structuredClone(fields);
  const list = tasks ? [...tasks] : undefined;
  const states = list?.map((task) => structuredClone(task));
  return () => {
    restore(record, tasks ? { ...saved, tasks } : saved);
    if (tasks && list) tasks.splice(0, tasks.length, ...list);
    list?.forEach((task, index) => restore(task, states![index]!));
  };
}

function restore(target: object, saved: object): void {
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(saved, key)) delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, saved);
}

const PERMISSION_FIELDS = ["approvalMode", "autoApprove", "alwaysAllow"] as const;

/**
 * The only task changes whose save may wait (server/save-batch.ts saveLater), because losing the last second of them in
 * a crash changes nothing a turn or a person relies on:
 * - `lastContextModel` (which model the last context reading was for): lost, the next compaction check reads the
 *   context size as unmeasured, as after a fresh start.
 * - `unread: true` set by a turn's own end (`turnEnd`): lost, a thread that just answered shows as read.
 * - `usage` (addTaskUsage, not a patch): lost, the thread's token counters are short by the last turn. Plan limits and
 *   billing read their own ledgers, not these.
 * Everything else is saved before the call returns: an engine session set or cleared, which engine has the thread, what
 * was handed to it, when the person last wrote, read marks, a person's own unread mark, titles, grants.
 */
const DEFERRABLE_FIELDS: ReadonlySet<string> = new Set(["lastContextModel"]);

export const deferrablePatch = (patch: TaskPatch, turnEnd = false): boolean => {
  const keys = Object.keys(patch);
  return keys.length > 0 && (keys.every((key) => DEFERRABLE_FIELDS.has(key)) || (turnEnd && keys.length === 1 && patch.unread === true));
};

export const touchesPermissions = (patch: TaskPatch): boolean => PERMISSION_FIELDS.some((key) => Object.hasOwn(patch, key));

/** A revocation stays live when its save fails; a widening never does. */
export function keptRevocation(before: ApprovalFields, after: ApprovalFields, patch: TaskPatch): TaskPatch | undefined {
  const fields = PERMISSION_FIELDS.filter((key) => Object.hasOwn(patch, key));
  if (!fields.length) return undefined;
  const allowed = before.alwaysAllow ?? [];
  if (approvalModeWidens(approvalModeFor(before), approvalModeFor(after))) return undefined;
  if ((after.alwaysAllow ?? []).some((key) => !allowed.includes(key))) return undefined;
  return structuredClone(Object.fromEntries(fields.map((key) => [key, patch[key]])));
}
