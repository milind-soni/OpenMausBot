// An engine status check that could not finish (it ran out of time, was killed, or could not be started for want of room)
// says nothing about whether the engine is installed or signed in: on a starved machine (a small Cloud whose CPU is
// throttled while a bot's commands hold its memory) `<cli> --version` can take longer than its limit while the engine works.
// Such a check is never recorded as "unavailable": the registry keeps what it last knew and checks again later, and with
// nothing known it looks for the program file itself (no process started) and takes it as installed but unverified.
import { accessSync, constants } from "node:fs";

import { cliProgramFile } from "../cli-program.ts";
import type { ProviderSnapshot, RuntimeEvent } from "../contracts.ts";
import { shortageCode } from "../process-shortage.ts";

/** Before each check again after one that could not finish: then the last of these, until one answers. */
export const PROBE_RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
/** This many checks in a row that could not finish while the machine was not pressed are an answer: the engine is broken
 * (it hangs, or is killed each time), not starved. */
export const CALM_FAILURES_BELIEVED = 3;
/** A status this old is checked again even while the machine is pressed or the engine's turn runs. */
export const STATUS_STALE_MS = 10 * 60_000;
/** After the person's own change (an install, a sign-in), a check that could not finish is tried again this soon, this many
 * times, pressed or not; then as any other. */
export const PROMPT_RETRY_MS = 5_000;
export const PROMPT_RETRIES = 5;
/** How long after such a change its checks count as the person's own. */
export const PERSON_CHECK_MS = 2 * 60_000;
/** An event from one of the engine's turns this recently, with no end since, proves it runs: no check is needed then. */
export const TURN_PROOF_MS = 5 * 60_000;
/** On a small machine a status check waits for the one before it at most this long: longer than a CLI's own version check
 * may take (procs.ts CLI_VERSION_TIMEOUT_MS), so two never run at once there unless one is stuck past its own limit. */
export const PROBE_QUEUE_WAIT_MS = 35_000;

/** A failed `execFile` that says nothing about the program: cut off at its time limit, killed by SIGKILL (the OOM killer),
 * or never started for want of processes, open files or memory. A missing or non-executable file, an exit with a status,
 * or any other signal (a crash: SIGSEGV, SIGABRT) is an answer. */
export function inconclusiveFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown };
  if (shortageCode(failure)) return true;
  if (failure.killed === true && typeof failure.code !== "string") return true;
  return failure.signal === "SIGKILL" && typeof failure.code !== "number";
}

/** The `busy` mark a status read sets on an unavailable status whose check could not finish. */
export const inconclusiveMark = (error: unknown): { busy?: true } => (inconclusiveFailure(error) ? { busy: true } : {});

/** The mark on a probe result, for a read that keeps it in a type of its own. */
export const busyOf = (probe: object): { busy?: true } => ("busy" in probe && probe.busy === true ? { busy: true } : {});

/** Whether the program this CLI runs is an executable file on the PATH engines are started with: a look at the file, never a
 * process. */
export function cliPresent(cli: string, platform: NodeJS.Platform = process.platform, find: (cli: string) => string | null = (one) => cliProgramFile(one)): boolean {
  const file = find(cli);
  if (!file) return false;
  try {
    accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a check that could not finish leaves recorded: the last status that said the engine was there, while its program
 * file is still there (a saved status never brings back a deleted engine); else, when the file is there, installed but
 * unverified; else not installed. */
export function heldSnapshot(before: ProviderSnapshot | undefined, now: ProviderSnapshot, present: () => boolean | null): ProviderSnapshot {
  const file = present();
  if (before?.state === "available" && file !== false) return before;
  if (file === true) return { state: "available", unverified: true, ...(before?.version ? { version: before.version } : {}) };
  if (file === false) {
    const { busy: _busy, ...missing } = now;
    return { ...missing, state: "unavailable" };
  }
  return { ...now, state: "unavailable", busy: true };
}

const TERMINAL = new Set<RuntimeEvent["type"]>(["turn.completed", "session.exited"]);

/** Which threads have a turn under way on one engine, from its own events: the latest activity of each. */
export function turnActivity(now: () => number = Date.now) {
  const threads = new Map<string, number>();
  return {
    note(event: RuntimeEvent): void {
      if (TERMINAL.has(event.type) || (event.type === "runtime.error" && event.terminal === true)) threads.delete(event.threadId);
      else threads.set(event.threadId, now());
    },
    running(): boolean {
      const at = now();
      for (const [threadId, seen] of threads) {
        if (at - seen < TURN_PROOF_MS && at >= seen) return true;
        threads.delete(threadId);
      }
      return false;
    },
  };
}
