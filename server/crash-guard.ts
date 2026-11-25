// What the server does with an error nothing caught. Without this, one bad callback ended the server with every turn
// in flight; the launcher did not start it again, and the turns it reran at the next start failed if it fell again.
//
// The rule:
// - A promise rejection nobody handled is survivable: the operation it belonged to is over, and what it changed before
//   failing was written step by step. It is logged, and the turn it ran for (if any) is stopped.
// - An exception thrown by an engine driver's own code while it runs a turn is that turn's: the turn is stopped and its
//   resources freed, the server stays up. Only driver code runs in a turn's scope (withTurnScope wraps sendTurn); what a
//   driver hands the server (its events) runs outside it, so an error in shared server code is never filed as a turn's.
//   If that turn is no longer running (a warm process or timer outlived it), nothing can be stopped: that is fatal.
// - An exception from a socket or pipe whose other end went away (EPIPE, ECONNRESET, ...) is survivable: it is logged.
// - Anything else (an exception outside any turn, a stack overflow, an internal assertion) may have left shared state
//   half-changed: the server marks its running turns cut (so the next start reruns them), flushes nothing else it
//   holds in memory (the files keep their last whole state), and exits with CRASH_EXIT_CODE; its launcher starts it
//   again after a pause.
// - More than STORM_LIMIT errors within STORM_WINDOW_MS is treated as the last kind, so a failing loop cannot keep the
//   server up and broken.
import { AsyncLocalStorage } from "node:async_hooks";

import type { ProviderInstance } from "./contracts.ts";
import { CRASH_EXIT_CODE } from "./restart.ts";

export interface TurnScope { botId: string; threadId: string }

const scope = new AsyncLocalStorage<TurnScope>();

/** Runs a turn's work so that an error nothing catches inside it, however late, is known to be that turn's. */
export const runInTurn = <T>(turn: TurnScope, run: () => T): T => scope.run(turn, run);
export const currentTurn = (): TurnScope | undefined => scope.getStore();
/** Runs server code a driver calls into (its event listeners) outside any turn's scope. */
export const outsideTurn = <T>(run: () => T): T => scope.exit(run);

/** A driver's sendTurn runs in the turn's scope, and its events reach the server's listeners outside it. */
export function withTurnScope<I extends Pick<ProviderInstance, "adapter">>(instance: I): I {
  const adapter = instance.adapter;
  (instance as { adapter: ProviderInstance["adapter"] }).adapter = {
    ...adapter,
    sendTurn: (input) => runInTurn({ botId: input.botId ?? "", threadId: input.threadId }, () => adapter.sendTurn(input)),
    // An engine started ahead of its first turn is that conversation's too: what it throws later belongs to the turn that took it.
    ...(adapter.prestart ? { prestart: { ...adapter.prestart, start: (input, waitMs) => runInTurn({ botId: input.botId ?? "", threadId: input.threadId }, () => adapter.prestart!.start(input, waitMs)) } } : {}),
    onEvent: (listener) => adapter.onEvent((event) => outsideTurn(() => listener(event))),
  };
  return instance;
}

/** What the person is told in a turn the guard stopped. */
export const SERVER_ERROR_CAUSE = "turn stopped — the server hit an unexpected error (details in the server log)";

export const STORM_LIMIT = 10;
export const STORM_WINDOW_MS = 60_000;
/** Closing after a fatal error may take this long before the process exits anyway. */
export const FATAL_EXIT_DEADLINE_MS = 20_000;

const PEER_GONE = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED", "ENOTCONN", "ETIMEDOUT", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_PREMATURE_CLOSE"]);

export type CrashVerdict = "fail-turn" | "keep" | "exit";

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

export function crashVerdict(kind: "exception" | "rejection", error: unknown, turn: TurnScope | undefined, inWindow: number): CrashVerdict {
  if (inWindow > STORM_LIMIT) return "exit";
  if (error instanceof RangeError && /call stack/i.test(error.message)) return "exit";
  if (codeOf(error) === "ERR_INTERNAL_ASSERTION") return "exit";
  if (turn) return "fail-turn";
  if (kind === "rejection") return "keep";
  return PEER_GONE.has(codeOf(error) ?? "") ? "keep" : "exit";
}

/** The error as one log line and its stack, with nothing from the process's environment. */
export function crashLine(kind: "exception" | "rejection", error: unknown, turn: TurnScope | undefined, verdict: CrashVerdict, redact: (text: string) => string): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const where = turn ? `in the turn of bot ${turn.botId} thread ${turn.threadId}` : "outside any turn";
  const what = verdict === "exit" ? "the server closes and starts again" : verdict === "fail-turn" ? "that turn is stopped, the server stays up" : "the server stays up";
  const stack = error instanceof Error && error.stack ? `\n${error.stack.split("\n").slice(1, 9).join("\n")}` : "";
  return redact(`crash guard: ${kind === "exception" ? "uncaught exception" : "unhandled rejection"} ${where}${codeOf(error) ? ` [${codeOf(error)}]` : ""}: ${name}: ${message.slice(0, 500)} — ${what}${stack}`);
}

export interface CrashGuardDeps {
  /** Stops the turn and frees what it holds; false when the turn had already ended. */
  failTurn(turn: TurnScope, detail: string): boolean;
  /** The close after a fatal error: mark running turns cut, flush nothing else, process.exit(code). */
  shutdown(code: number): void;
  log?: (line: string) => void;
  redact?: (text: string) => string;
  now?: () => number;
  exit?: (code: number) => void;
  on?: (event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void) => void;
}

export function installCrashGuard(deps: CrashGuardDeps) {
  const log = deps.log ?? ((line: string) => console.error(line)), redact = deps.redact ?? ((text: string) => text);
  const now = deps.now ?? Date.now, exit = deps.exit ?? ((code: number) => process.exit(code));
  const recent: number[] = [];
  let closing = false;
  const handle = (kind: "exception" | "rejection") => (error: unknown) => {
    try {
      const at = now();
      while (recent.length && at - recent[0]! > STORM_WINDOW_MS) recent.shift();
      recent.push(at);
      const turn = currentTurn();
      let verdict = closing ? "exit" : crashVerdict(kind, error, turn, recent.length);
      log(crashLine(kind, error, turn, verdict, redact));
      if (verdict === "fail-turn" && turn) {
        let stopped = false;
        try { stopped = deps.failTurn(turn, error instanceof Error ? error.name : "error"); } catch (failure) { log(redact(`crash guard: stopping the turn failed: ${String(failure)}`)); }
        if (stopped) return;
        log(`crash guard: no running turn of thread ${turn.threadId} to stop — the server closes and starts again`);
        verdict = "exit";
      }
      if (verdict !== "exit") return;
      if (closing) { exit(CRASH_EXIT_CODE); return; }
      closing = true;
      // Ref'd on purpose: a close that hangs still ends here.
      setTimeout(() => exit(CRASH_EXIT_CODE), FATAL_EXIT_DEADLINE_MS);
      deps.shutdown(CRASH_EXIT_CODE);
    } catch {
      exit(CRASH_EXIT_CODE);
    }
  };
  const on = deps.on ?? ((event, listener) => { process.on(event, listener); });
  on("uncaughtException", handle("exception"));
  on("unhandledRejection", handle("rejection"));
  return { closing: () => closing };
}
