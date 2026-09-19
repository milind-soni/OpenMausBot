// The Claude driver's per-thread bookkeeping types. Split out of
// drivers/claude.ts so the session record can be shared (type-only) between
// the driver core and the stream-event mapper.
import type { SendTurnInput } from "../../contracts.ts";
import type { spawnCli } from "../../procs.ts";
import type { createPermissionBroker } from "./permission-broker.ts";

// One live CLI process per thread, kept across turns. Under
// --input-format stream-json the CLI settles a turn with `result` while
// stdin stays open, takes the next user message on the same stdin as a
// new turn, and folds a message that arrives MID-turn into the running
// one before its next model call (verified against 2.1.221 — that fold
// is what "steer" is). So a session is spawned once, reused while its
// spawn contract (args, MCP config, cwd, model) is unchanged, closed
// after SESSION_IDLE_MS of quiet, and resumed by --resume when needed.
export interface Session {
  child: ReturnType<typeof spawnCli>;
  broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
  mcpConfigPath: string | null;
  systemPromptPath: string | null;
  /** the spawn contract — a different one means a fresh process */
  argsKey: string;
  /** the volatile half of the system prompt this process was launched
   * with (see SendTurnInput.systemVolatile). A later turn whose volatile
   * text differs delivers the difference in-turn rather than relaunching. */
  volatile: string;
  /** the CLI's session id from `init`, what --resume takes later */
  sessionId: string | null;
  /** the CLI emitted its `init` frame — it accepted the session and
   * began the turn. The acceptance boundary for --resume: before it,
   * nothing was submitted and the turn has caused nothing. */
  sawInit: boolean;
  /** the permission mode `init` says the session actually runs in. The
   * CLI takes `--permission-mode auto` for any model and starts in
   * "default" without a word when auto mode is unavailable (Haiku 4.5,
   * Sonnet 4.5, an org that disabled it), so the flag we passed is not
   * the truth — this is. null until init, or on a CLI that omits it. */
  nativePermissionMode: string | null;
  /** the running turn, or null between turns */
  turn: { turnId: string; input: SendTurnInput; retryAbort: AbortController; settled: boolean; sawStreamDelta: boolean; authFailed?: boolean } | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  stderr: string;
  /** Root close can precede a failed group stop; retry its finalization. */
  finishClose?: () => Promise<void>;
}

// one active turn per thread; a second send while busy is a caller bug
export interface ActiveTurn {
  stop: () => void;
  turnId: string;
  broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
}
