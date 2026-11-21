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
   * and `required` is told, instead of the turn waiting on a sign-in nobody sees. */
  signInRequest?: {
    /** Whether a whole stderr line announces the request. */
    stderrLine(line: string): boolean;
    /** Whether a request's error means the same. */
    rpcError(error: unknown): boolean;
    required(instanceId: string): void;
  };
  /** Every agent process the driver starts for turns. */
  processStarted?(child: ChildProcess, instanceId: string): void;
  /** Extra session/new, session/load and session/resume parameters, from the agent's initialize answer. */
  sessionSetupParams?(initializeResult: unknown): Record<string, unknown>;
  /** The `clientInfo` of initialize, for an agent that reads it; the app's own name when unset or undefined. */
  clientInfo?(instanceId: string): { name: string; version: string } | undefined;
  /** Called before each session/prompt. The check it returns gets that prompt's result and names the failure the agent
   * reported as an ordinary reply, which then fails the turn. Neither may throw. */
  promptOutcome?(instanceId: string, sessionId: string): Promise<(result: unknown) => Promise<Error | undefined>>;
  /** The failure a turn's thrown error stands for, in the person's words (a usage limit with its reset), or undefined to
   * keep the error as it is. Must not throw. */
  reportedFailure?(error: unknown): Error | undefined;
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
    if (!this.#support.signInRequest?.rpcError(error)) return null;
    this.#support.signInRequest.required(this.#instanceId);
    return this.#error();
  }
}
