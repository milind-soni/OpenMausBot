// What a bot on one of the person's own Clouds asks of this computer when it can't use it now.
// Each ask comes up once in a prompt of this app's own; Turn on there, or on the card anywhere, does here what it takes.
// After Not now nothing more comes up for that Cloud and need for a while: the card stays in the chat.
import { fixableHere } from "./screen-words.mjs";

/** After Not now in the prompt, the same Cloud asking for the same thing comes up again only after this long. */
export const QUIET_AFTER_NOT_NOW_MS = 30 * 60_000;

/**
 * `prompt(env, ask, signal)`: this app's own prompt, "turn-on", "not-now", or null when it didn't show (the person is
 * looking at that Cloud, where the card is) or `signal` closed it. `turnOn(env, ask)`: does here what the ask needs,
 * `{ ok: true }`, `{ ok: false, reason }` (why it still can't) or `{ declined: true }`. `answered(envId)`: an answer
 * waits to go to that Cloud.
 */
export function createComputerAsks({ prompt, turnOn, answered = () => {}, now = Date.now, log = () => {} }) {
  /** Per ask: the card's Turn on taps already done here. */
  const acted = new Map();
  /** Per ask that came up: what closes its prompt. */
  const prompted = new Map();
  /** The Clouds whose prompt is up now: one at a time each, the next on a later poll. */
  const showing = new Set();
  const quietUntil = new Map();
  const answers = new Map();

  const answer = (envId, entry) => {
    answers.set(envId, [...(answers.get(envId) ?? []).filter(other => other.id !== entry.id), entry]);
    answered(envId);
  };

  async function act(env, ask) {
    let result;
    try { result = await turnOn(env, ask); }
    catch (error) { log(`turning on for ${env.name}: ${error?.message ?? error}`); result = { ok: false }; }
    if (result?.declined) answer(env.id, { id: ask.id, outcome: "declined" });
    else if (result?.ok !== true) answer(env.id, { id: ask.id, outcome: "failed", ...(typeof result?.reason === "string" ? { reason: result.reason } : {}) });
  }

  return {
    /** What waits to go to this Cloud with its next poll. */
    pending: envId => answers.get(envId) ?? [],
    /** They reached this Cloud. */
    sent(envId, sent) {
      const left = (answers.get(envId) ?? []).filter(entry => !sent.includes(entry));
      if (left.length) answers.set(envId, left); else answers.delete(envId);
    },
    /** The asks a Cloud has open now. */
    heard(env, asks) {
      const open = new Map(asks.filter(ask => ask && typeof ask.id === "string").map(ask => [ask.id, ask]));
      for (const [id, close] of prompted) if (open.get(id)?.state !== "asking") { close.abort(); prompted.delete(id); }
      for (const ask of open.values()) {
        const taps = Number.isSafeInteger(ask.turnOn) ? ask.turnOn : 0;
        if (taps > (acted.get(ask.id) ?? 0)) {
          acted.set(ask.id, taps);
          prompted.get(ask.id)?.abort();
          void act(env, ask);
          continue;
        }
        const quiet = `${env.id}\n${ask.need}`;
        if (ask.state !== "asking" || acted.has(ask.id) || prompted.has(ask.id) || showing.has(env.id) || !fixableHere(ask.reason) || (quietUntil.get(quiet) ?? 0) > now()) continue;
        const close = new AbortController();
        prompted.set(ask.id, close);
        showing.add(env.id);
        void Promise.resolve().then(() => prompt(env, ask, close.signal)).finally(() => showing.delete(env.id)).then(choice => {
          if (close.signal.aborted || !choice) return;
          if (choice === "turn-on") {
            acted.set(ask.id, Math.max(taps, acted.get(ask.id) ?? 0));
            answer(env.id, { id: ask.id, outcome: "turning-on" });
            void act(env, ask);
            return;
          }
          quietUntil.set(quiet, now() + QUIET_AFTER_NOT_NOW_MS);
          answer(env.id, { id: ask.id, outcome: "declined" });
        }, error => log(`asking about ${env.name}: ${error?.message ?? error}`));
      }
    },
    /** Lending stopped for good: every prompt closes. */
    close() { for (const close of prompted.values()) close.abort(); prompted.clear(); },
  };
}
