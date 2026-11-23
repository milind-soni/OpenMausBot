// One compact line per ACP engine turn on how its start went: a new process or a kept one, how long the agent took to
// answer each protocol step before the prompt, and how long from the prompt to its first update. Always on, written to
// the server log and kept (the latest few) for the desktop's diagnostics export. Only the engine's kind, fixed words and
// numbers: no ids, prompts, paths, tokens or accounts.

/** The diagnostics export keeps this many of the latest lines. */
export const TURN_STARTS_KEPT = 20;

const recent: string[] = [];

/** The protocol steps a line names, in the order they run; anything else sent before the prompt counts as config. */
const STEPS = ["initialize", "authenticate", "session/resume", "session/load", "session/new"] as const;
const CONFIG = new Set(["session/set_config_option", "session/set_model", "session/set_mode"]);

export interface TurnStartClock {
  /** A request the turn sent before its prompt was answered or failed after `ms`. */
  call(method: string, ms: number): void;
  /** The turn waited `ms` for something before its engine: the startup model read, or room in memory. */
  waited(what: "models" | "room", ms: number): void;
  /** The turn started a process of its own (`spawnedAt`), rather than one kept from an earlier turn. */
  spawned(at: number): void;
  promptSent(at: number): void;
  firstUpdate(at: number): void;
  retried(): void;
  /** Writes the line once; later calls do nothing. */
  finish(outcome: string, at: number): string | null;
}

const ms = (value: number) => (value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);

export function turnStartClock(engine: string, startedAt: number, log: (line: string) => void = (line) => console.info(line)): TurnStartClock {
  const steps = new Map<string, number>();
  const waits = { models: 0, room: 0 };
  let config = 0, configMs = 0, spawnedAt: number | null = null, initializedAfter: number | null = null;
  let promptAt: number | null = null, firstAt: number | null = null, retries = 0, done = false;
  return {
    call(method, took) {
      if (promptAt !== null) return;
      if (CONFIG.has(method)) { config += 1; configMs += took; return; }
      if (method === "initialize" && spawnedAt !== null) initializedAfter = Date.now() - spawnedAt;
      steps.set(method, (steps.get(method) ?? 0) + took);
    },
    waited(what, took) { waits[what] += took; },
    spawned(at) { spawnedAt ??= at; },
    promptSent(at) { promptAt ??= at; },
    firstUpdate(at) { if (promptAt !== null) firstAt ??= at; },
    retried() { retries += 1; },
    finish(outcome, at) {
      if (done) return null;
      done = true;
      const parts = [
        spawnedAt !== null ? "new process" : promptAt !== null || steps.size || config ? "kept process" : "no process",
        `models waited ${ms(waits.models)}`,
        ...(waits.room ? [`room waited ${ms(waits.room)}`] : []),
        ...(initializedAfter !== null ? [`spawn to initialize ${ms(initializedAfter)}`] : []),
        ...STEPS.filter((step) => step !== "initialize" && steps.has(step)).map((step) => `${step.replace("session/", "session ")} ${ms(steps.get(step)!)}`),
        ...(STEPS.some((step) => step.startsWith("session/") && steps.has(step)) || promptAt === null ? [] : ["session live"]),
        `config ${config} call${config === 1 ? "" : "s"} ${ms(configMs)}`,
        promptAt === null ? "no prompt" : firstAt === null ? "prompt to first update none" : `prompt to first update ${ms(firstAt - promptAt)}`,
        `total ${ms(at - startedAt)}`,
        ...(retries ? [`retried ${retries}`] : []),
        `ended ${/^[\w-]{1,40}$/u.test(outcome) ? outcome : "other"}`,
      ];
      const line = `[perf] engine turn ${/^[\w-]{1,40}$/u.test(engine) ? engine : "acp"}: ${parts.join(", ")}`;
      recent.push(line);
      if (recent.length > TURN_STARTS_KEPT) recent.splice(0, recent.length - TURN_STARTS_KEPT);
      try { log(line); } catch {}
      return line;
    },
  };
}

/** Hands back `request` unchanged, noting how long it took once it settles; a prompt is timed by its first update. */
export function timed<T>(clock: TurnStartClock, method: string, request: Promise<T>): Promise<T> {
  if (method === "session/prompt") return request;
  const sentAt = Date.now();
  const note = () => clock.call(method, Date.now() - sentAt);
  request.then(note, note);
  return request;
}

/** The latest lines, oldest first, for the diagnostics export. */
export function recentTurnStarts(): readonly string[] {
  return [...recent];
}

export function turnStartsSection(): string[] {
  return recent.length ? ["## Engine turn starts (latest, oldest first)", ...recent] : [];
}
