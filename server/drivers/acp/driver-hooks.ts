// What a driver may ask of the shared ACP runtime beyond its protocol answers. Only a driver that sets one of these
// changes behaviour.
import type { ChildProcess } from "node:child_process";

import type { SendTurnInput } from "../../contracts.ts";
import type { AcpConfig } from "./core.ts";
import type { AcpHost } from "./host.ts";

export interface AcpDriverHooks {
  /** Local video, image, audio and PDF files named in the turn text go to the model as `resource_link` blocks
   * the agent reads itself, for an agent whose own file tool returns media as raw bytes (Antigravity). */
  mediaLinks?: boolean;
  /** An agent that asks for a sign-in no turn can give. Its turns fail at once with `loginNote`, its process is closed
   * and `required` is told, instead of the turn waiting on a sign-in nobody sees. Only these say the account is signed
   * out: any other `authenticate` failure fails the turn as an ordinary startup error. */
  signInRequest?: {
    /** Whether a whole stderr line announces the request. */
    stderrLine(line: string): boolean;
    /** Whether a request's error means the same. */
    rpcError(error: unknown, instanceId: string): boolean;
    required(instanceId: string): void;
  };
  /** Whether this instance's agent is never sent `authenticate`, because it answers by opening a browser nobody sees: its
   * turns, background text and model discovery start the session directly, and a session it refuses for want of a sign-in
   * fails as a sign-in request. */
  skipsAuthenticate?(instanceId: string): boolean;
  /** Every agent process the driver starts for turns and background text. */
  processStarted?(child: ChildProcess, instanceId: string): void;
  /** Extra session/new, session/load and session/resume parameters, from the agent's initialize answer. `system` is the
   * session's system prompt when sessionSystemPrompt holds. */
  sessionSetupParams?(initializeResult: unknown, system?: string): Record<string, unknown>;
  /** Whether this instance's agent takes the system prompt through sessionSetupParams instead of in the prompt text, where
   * it would read words of it as the person's commands. A changed system prompt then loads the live session again. */
  sessionSystemPrompt?(initializeResult: unknown, instanceId: string): boolean;
  /** The `clientInfo` of initialize, for an agent that reads it; the app's own name when unset or undefined. */
  clientInfo?(instanceId: string): { name: string; version: string } | undefined;
  /** Whether the driver answers this permission request with "allow" itself, with no card: for an agent that asks
   * about actions the turn's approval level already covers. Never consulted for a question or a never-list command. */
  allowsAlone?(instanceId: string, turn: { approvalMode?: string; approvalModeNow?: () => string; cwd?: string }, toolCall: { kind?: unknown; rawInput?: unknown; locations?: unknown }): boolean;
  /** Called before each session/prompt. The check it returns gets that prompt's result and names the failure the agent
   * reported as an ordinary reply, which then fails the turn. Neither may throw. */
  promptOutcome?(instanceId: string, sessionId: string): Promise<(result: unknown) => Promise<Error | undefined>>;
  /** The failure a turn's thrown error stands for, in the person's words (a usage limit with its reset), or undefined to
   * keep the error as it is. Must not throw. */
  reportedFailure?(error: unknown): Error | undefined;
  /** Gets the last text chunk of a prompt the agent answered with end_turn. When the agent sent a failed model call as
   * that chunk instead of failing the prompt, returns the failure in its words, which fails the turn as a thrown one
   * does; the text before the chunk stays the reply. Null for any other chunk. */
  replyFailure?(chunk: string): string | null;
  /** initialize's own `_meta` (beside clientCapabilities' vendor `_meta`), for an agent that reads who its client is there. */
  initializeMeta?: Record<string, unknown>;
  /** session/cancel's `_meta`, for an agent that reads how its turn was stopped there. */
  cancelMeta?: Record<string, unknown>;
  /** An agent that also ends each prompt with a notification of its own, which may come before the prompt's reply or
   * without it. */
  promptCompletion?: AcpPromptCompletion;
  /** For an agent that can leave session/load unanswered after replaying the history: how long the replay must go quiet
   * before the load counts as done. Undefined waits for the answer. */
  loadReplayQuietMs?(turn: SendTurnInput): number | undefined;
  /** The part of spawnArgs a running process must match for a turn to reuse it. What it leaves out, configureSession
   * changes inside the live session, throwing LiveSwitchRefused when the agent refuses; a reused session then restarts. */
  spawnContractArgs?(config: AcpConfig, turn: SendTurnInput): string[];
}

/** How an agent names the end of a prompt outside its session/prompt reply. */
export interface AcpPromptCompletion {
  /** `_meta` each session/prompt carries, so the agent names that prompt when it ends. */
  meta(promptId: string): Record<string, unknown>;
  /** The prompt a notification ends (its session, and its id or null when it names none) and its answer in a session/prompt
   * reply's shape; null for any other notification. */
  read(msg: { method?: unknown; params?: unknown }): { sessionId: string; promptId: string | null; result: { stopReason: string; error?: string } } | null;
}

/** configureSession could not change a running session's model or effort in place. */
export class LiveSwitchRefused extends Error {}

const MAX_LINE_CHARS = 64 * 1024;

export class SignInRequests {
  readonly #asked = new WeakSet<AcpHost>();
  readonly #support: AcpDriverHooks & { loginNote: string };
  readonly #instanceId: string;

  constructor(support: AcpDriverHooks & { loginNote: string }, instanceId: string) {
    this.#support = support;
    this.#instanceId = instanceId;
  }

  #error(): Error {
    return Object.assign(new Error(this.#support.loginNote), { acpSignInRequired: true });
  }

  watch(host: AcpHost): void {
    this.#support.processStarted?.(host.child, this.#instanceId);
    const request = this.#support.signInRequest;
    if (!request) return;
    let partial = "";
    host.child.stderr.on("data", (chunk: string | Buffer) => {
      const lines = (partial + String(chunk)).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > MAX_LINE_CHARS) partial = "";
      if (this.#asked.has(host) || !lines.some((line) => request.stderrLine(line.replace(/\r$/u, "")))) return;
      this.#asked.add(host);
      host.draining = true;
      request.required(this.#instanceId);
      for (const link of host.links) link.failAll(this.#error());
    });
  }

  /** A rejection for any further request to a process that asked; null for every other process. */
  refused(host: AcpHost): Promise<never> | null {
    return this.#asked.has(host) ? Promise.reject(this.#error()) : null;
  }

  is(error: unknown): boolean {
    return (error as { acpSignInRequired?: unknown } | null)?.acpSignInRequired === true;
  }

  /** The sign-in failure `error` stands for, or null when it is some other failure. */
  asked(error: unknown): Error | null {
    if (this.is(error)) return error as Error;
    if (!this.#support.signInRequest?.rpcError(error, this.#instanceId)) return null;
    this.#support.signInRequest.required(this.#instanceId);
    return this.#error();
  }

  authenticateFailed(error: unknown, authFailure: "fail" | "fail-request" | "continue"): Error | null {
    const asked = this.asked(error);
    if (asked) return asked;
    if (authFailure === "continue") return null;
    if (!this.#support.signInRequest) return new Error(this.#support.loginNote);
    return error instanceof Error ? error : new Error(String(error));
  }
}
