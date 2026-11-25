// Why an engine did not start, per thread, for the health report's failure code (cloud-health.ts): the start (ACP
// session/new, drivers/acp/busy-start.ts) notes it as it throws, and the failed row that follows takes it. Written only on
// a failed start and read only on a failed row: nothing on a turn that starts. Codes only, never the engine's words.
export type StartFailureClass = "overloaded" | "provider";

/** A note older than this belongs to no row: the failed row is written within seconds of the start failing. */
export const START_FAILURE_KEEP_MS = 120_000;
const CAP = 200;
const noted = new Map<string, { at: number; why: StartFailureClass }>();

export function noteStartFailure(threadId: string, why: StartFailureClass, at = Date.now()): void {
  noted.delete(threadId);
  noted.set(threadId, { at, why });
  if (noted.size > CAP) noted.delete(noted.keys().next().value as string);
}

/** A start on this thread failed for a reason that keeps its own code (a sign-in): any earlier note goes. */
export function clearStartFailure(threadId: string): void { noted.delete(threadId); }

/** This thread's start failure noted within START_FAILURE_KEEP_MS of `at`, taken (a second row doesn't get it). */
export function takeStartFailure(threadId: string, at = Date.now()): StartFailureClass | null {
  const found = noted.get(threadId);
  if (!found) return null;
  noted.delete(threadId);
  return Math.abs(at - found.at) <= START_FAILURE_KEEP_MS ? found.why : null;
}
