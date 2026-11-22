import type { ModelSelection } from "../contracts.ts";
import { ENGINE_LIST_REUSE_MS } from "../harness/registry.ts";

/** The oldest engine status New bot's offer may rest on; past it the engine is read again before the answer. */
export const SUGGESTION_MAX_AGE_MS = 10 * 60_000;

/**
 * The engine and model New bot offers. Answered from the status reads the engine list already holds, so opening New bot
 * spawns no CLI; when those reads name no engine (nothing was ready, or nothing was read yet) every engine is read
 * again first, so one installed or signed in from a terminal a moment ago is found.
 *
 * Known open risk: nothing checks the offer's engine status again before the bot is made. An engine removed or signed
 * out outside the app within SUGGESTION_MAX_AGE_MS of its last read can be offered once; the bot is then made on it and
 * its first turn reports the engine's own sign-in or missing-CLI problem.
 */
export async function suggestedSelection<Instance>(engines: {
  reused(age: { ms: number; maxAgeMs: number }): Promise<readonly Instance[]>;
  fresh(): Promise<readonly Instance[]>;
  select(instances: readonly Instance[]): Promise<ModelSelection>;
}): Promise<ModelSelection> {
  const quick = await engines.select(await engines.reused({ ms: ENGINE_LIST_REUSE_MS, maxAgeMs: SUGGESTION_MAX_AGE_MS }));
  if (quick.instanceId && quick.model) return quick;
  return engines.select(await engines.fresh());
}
