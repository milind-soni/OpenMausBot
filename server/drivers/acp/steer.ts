// ACP has no steer method, so each agent takes a message into its running turn its own way: a slash command it
// advertises (`available_commands_update`, Hermes), an extension request (`_session/steering`, OpenCode 2.3.0), or a
// second session/prompt (Devin, 3000.13.4).
import type { SteerOutcome } from "../../contracts.ts";

/** How an agent takes a person's message into its running turn. */
export interface AcpCommandSteer {
  /** The slash command, as the agent advertises it in `available_commands_update`. */
  command: string;
  /** The agent's own answer to the command, one agent_message_chunk: "accepted" when it took the text, "refused" when
   * it provably did not, null for any other text. */
  answer(chunk: string): "accepted" | "refused" | null;
}

/** OpenCode 2.3: an ACP extension request that `initialize` reports in `_meta.steering.supported`. The turn's own prompt stays open. */
export interface AcpRequestSteer {
  kind: "request";
  method: string;
  /** Whether this process's `initialize` result reports the request. */
  supported(initializeResult: unknown): boolean;
}

/** Devin: a second `session/prompt` joins the running turn, for a CLI whose `initialize` sets `agentCapabilities._meta[capability]`.
 * Both prompts end together; their replies carry the same usage and the same `run`. */
export interface AcpPromptSteer {
  kind: "prompt";
  capability: string;
  /** The run a prompt reply ends; replies of one run report their usage once. */
  run(response: unknown): string | undefined;
}

export type AcpSteerSupport = AcpCommandSteer | AcpRequestSteer | AcpPromptSteer;

export interface AcpTurnSteering {
  /** True for the agent's answer to a steer still out, which is never part of the reply. */
  swallow(chunk: string): boolean;
  steer(text: string): Promise<SteerOutcome>;
  /** The turn's own prompt is answered: no new steer starts. Null when no steer is out; otherwise resolves once they
   * have ended, and a steer the agent ran as a prompt of its own streams into this turn until then. */
  promptAnswered(): Promise<void> | null;
  /** Replies of the steer prompts that ended, once `promptAnswered` has resolved. */
  replies?: unknown[];
  /** A steer prompt that failed after it was reported as steered. */
  failure?: unknown;
}

/** The names an `available_commands_update` advertises, or null when it is not one. */
export function advertisedCommands(update: unknown): Set<string> | null {
  const commands = (update as { sessionUpdate?: unknown; availableCommands?: unknown } | null);
  if (commands?.sessionUpdate !== "available_commands_update" || !Array.isArray(commands.availableCommands)) return null;
  return new Set(commands.availableCommands.flatMap((command) => typeof command?.name === "string" ? [command.name] : []));
}

/** `running`: the turn's own prompt is out, nothing stopped it, and its session offers the command. `send` carries
 * one session/prompt text and settles when the agent answers it, fails, or the turn ends. */
export function acpTurnSteering(support: AcpCommandSteer, running: () => boolean, send: (text: string) => Promise<unknown>): AcpTurnSteering {
  let answered = false;
  let markAnswered = () => {};
  const answeredSignal = new Promise<void>((resolve) => { markAnswered = resolve; });
  const open = () => !answered && running();
  let flight: { verdict: "accepted" | "refused" | null; decide: (outcome: SteerOutcome) => void } | null = null;
  // One steer out at a time, so each answer belongs to the one steer that is out.
  let previous: Promise<void> = Promise.resolve();
  let out = 0;

  const start = (text: string): { outcome: Promise<SteerOutcome>; done: Promise<void> } => {
    const guidance = text.trim();
    if (!guidance || !open()) return { outcome: Promise.resolve("refused"), done: Promise.resolve() };
    let decide: (outcome: SteerOutcome) => void = () => {};
    const outcome = new Promise<SteerOutcome>((resolve) => { decide = resolve; });
    const own = { verdict: null as "accepted" | "refused" | null, decide };
    flight = own;
    out += 1;
    // Answered first: the agent may run the words as its next prompt, which this turn now waits for.
    void answeredSignal.then(() => decide("indeterminate"));
    const done = send(`/${support.command} ${guidance}`).then(
      () => decide("indeterminate"),
      () => decide(own.verdict === null && open() ? "refused" : "indeterminate"),
    ).finally(() => {
      out -= 1;
      if (flight === own) flight = null;
    });
    return { outcome, done };
  };

  return {
    swallow(chunk) {
      const own = flight;
      const verdict = own ? support.answer(chunk) : null;
      if (!own || !verdict) return false;
      if (own.verdict === null) {
        own.verdict = verdict;
        own.decide(verdict === "refused" ? "refused" : open() ? "steered" : "indeterminate");
      }
      return true;
    },
    steer(text) {
      const started = previous.then(() => start(text));
      previous = started.then((one) => one.done);
      return started.then((one) => one.outcome);
    },
    promptAnswered() {
      answered = true;
      markAnswered();
      return out > 0 ? previous : null;
    },
  };
}

/** `send` carries one extension request. A JSON-RPC error (it has a numeric `code`) proves the agent kept nothing; anything
 * else, a timeout included, may have been delivered. */
export function acpRequestSteering(running: () => boolean, send: (text: string) => Promise<unknown>): AcpTurnSteering {
  let previous: Promise<unknown> = Promise.resolve();
  const one = async (text: string): Promise<SteerOutcome> => {
    const guidance = text.trim();
    if (!guidance || !running()) return "refused";
    try {
      const answer = await send(guidance) as { outcome?: unknown } | null;
      return answer?.outcome === "promptRequired" ? "refused" : "steered";
    } catch (error) {
      return typeof (error as { code?: unknown } | null)?.code === "number" ? "refused" : "indeterminate";
    }
  };
  return {
    swallow: () => false,
    steer(text) {
      const outcome = previous.then(() => one(text));
      previous = outcome;
      return outcome;
    },
    promptAnswered: () => null,
  };
}

/** `send` carries one `session/prompt` and settles when the agent answers it, at the end of the run. A steer is reported as
 * steered once it is sent: the agent gives no earlier answer. */
export function acpPromptSteering(running: () => boolean, send: (text: string) => Promise<unknown>): AcpTurnSteering {
  let answered = false;
  const pending = new Set<Promise<unknown>>();
  const steering: AcpTurnSteering = {
    replies: [],
    swallow: () => false,
    async steer(text) {
      const guidance = text.trim();
      if (!guidance || answered || !running()) return "refused";
      const sent = send(guidance).then(
        (reply) => { steering.replies!.push(reply); },
        (error) => { steering.failure ??= error; },
      ).finally(() => pending.delete(sent));
      pending.add(sent);
      return "steered";
    },
    promptAnswered() {
      answered = true;
      return pending.size ? Promise.all(pending).then(() => undefined) : null;
    },
  };
  return steering;
}

export interface AcpSteerIo {
  /** The turn's own prompt is out, nothing stopped it, and the session is live. */
  open(): boolean;
  commands(): ReadonlySet<string> | undefined;
  initializeResult(): any;
  prompt(text: string): Promise<unknown>;
  extension(method: string, text: string): Promise<unknown>;
}

export function turnSteering(support: AcpSteerSupport, io: AcpSteerIo): AcpTurnSteering {
  if ("kind" in support && support.kind === "request") {
    return acpRequestSteering(() => io.open() && support.supported(io.initializeResult()),
      (text) => io.extension(support.method, text));
  }
  if ("kind" in support && support.kind === "prompt") {
    return acpPromptSteering(() => io.open() && io.initializeResult()?.agentCapabilities?._meta?.[support.capability] === true, io.prompt);
  }
  return acpTurnSteering(support, () => io.open() && io.commands()?.has(support.command) === true, io.prompt);
}
