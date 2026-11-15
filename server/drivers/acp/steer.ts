// ACP has no steer method. An agent that takes a message into its running turn does it through a slash command it
// advertises (`available_commands_update`), sent as a second session/prompt while the turn's own prompt is open, and
// answers that prompt with a line of its own before its result.
import type { SteerOutcome } from "../../contracts.ts";

/** How an agent takes a person's message into its running turn. */
export interface AcpSteerSupport {
  /** The slash command, as the agent advertises it in `available_commands_update`. */
  command: string;
  /** The agent's own answer to the command, one agent_message_chunk: "accepted" when it took the text, "refused" when
   * it provably did not, null for any other text. */
  answer(chunk: string): "accepted" | "refused" | null;
}

export interface AcpTurnSteering {
  /** True for the agent's answer to a steer still out, which is never part of the reply. */
  swallow(chunk: string): boolean;
  steer(text: string): Promise<SteerOutcome>;
  /** The turn's own prompt is answered: no new steer starts. Null when no steer is out; otherwise resolves once they
   * have ended, and a steer the agent ran as a prompt of its own streams into this turn until then. */
  promptAnswered(): Promise<void> | null;
}

/** The names an `available_commands_update` advertises, or null when it is not one. */
export function advertisedCommands(update: unknown): Set<string> | null {
  const commands = (update as { sessionUpdate?: unknown; availableCommands?: unknown } | null);
  if (commands?.sessionUpdate !== "available_commands_update" || !Array.isArray(commands.availableCommands)) return null;
  return new Set(commands.availableCommands.flatMap((command) => typeof command?.name === "string" ? [command.name] : []));
}

/** `running`: the turn's own prompt is out, nothing stopped it, and its session offers the command. `send` carries
 * one session/prompt text and settles when the agent answers it, fails, or the turn ends. */
export function acpTurnSteering(support: AcpSteerSupport, running: () => boolean, send: (text: string) => Promise<unknown>): AcpTurnSteering {
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
