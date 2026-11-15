// What a driver may ask of the shared ACP runtime beyond its protocol answers. Only a driver that sets one of these
// changes behaviour.
import type { ChildProcess } from "node:child_process";

import type { AcpHost } from "./host.ts";

export interface AcpDriverHooks {
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
}

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
