import { addAbortListener } from "node:events";

import type { Routine, RoutineCheckResult, RoutineChecks } from "./routines.ts";
import type { CheckHold } from "./routine-check-pacing.ts";

const CHECK_TIMEOUT_MS = 2 * 60_000;
const DRAIN_TIMEOUT_MS = 60_000;

export class RoutineCheckDrainTimeoutError extends Error {}

export interface RoutineCheckLifecycle {
  timeoutMs?: number;
  drain?(): Promise<void>;
}

export async function runRoutineCheck(
  hook: RoutineChecks, routine: Routine, context: { manual: boolean; hold?: CheckHold },
  controller: AbortController, release: (key: string) => void, draining: Set<Promise<void>>,
): Promise<RoutineCheckResult> {
  let abandoned = false;
  let result: RoutineCheckResult | undefined;
  let failure: { error: unknown } | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<RoutineCheckResult>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      controller.abort();
      resolve({ trouble: "The checks timed out. Their result was discarded; try checking again." });
    }, hook.timeoutMs ?? CHECK_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const work = hook.check(routine, { ...context, signal: controller.signal, release }).then((result) => {
      if (abandoned && result.run) release(result.run.key);
      return result;
    });
    result = await Promise.race([work, deadline]);
  } catch (error) {
    failure = { error };
  } finally {
    clearTimeout(timer!);
  }
  try {
    await drainRoutineCheck(hook, draining);
  } catch (error) {
    abandoned = true;
    controller.abort();
    if (result?.run) release(result.run.key);
    throw error;
  }
  if (failure) throw failure.error;
  return result!;
}

async function drainRoutineCheck(hook: RoutineChecks, draining: Set<Promise<void>>): Promise<void> {
  const work = hook.drain?.();
  if (!work) return;
  draining.add(work);
  void work.then(() => draining.delete(work), () => draining.delete(work));
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RoutineCheckDrainTimeoutError("The checks finished, but background log writes are still draining. Backup must wait until they finish.")), DRAIN_TIMEOUT_MS);
      timer.unref?.();
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function awaitRoutineCheck<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let listener: ReturnType<typeof addAbortListener>;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason));
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    listener![Symbol.dispose]();
  }
}
