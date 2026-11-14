// A thread runs on its bot's model unless a person picked another model in
// that thread. The server stores no model for a thread that follows its bot;
// the wire carries the model the thread runs on plus followsBotModel, so the
// app and the phones read one effective model either way.
import type { ModelSelection } from "./wire.ts";

/** The same engine, model, effort and variant. */
export function sameModelSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;
}

/** A bot's threads that run on a model of their own, different from the
 * bot's: the ones "Switch them too" moves onto the bot's model. Reads the
 * wire shape, where only followsBotModel === false is a thread's own pick, so
 * a server too old to send it counts none. */
export function threadsOnOwnModel<T extends { modelSelection?: ModelSelection; followsBotModel?: boolean }>(
  botModel: ModelSelection,
  tasks: readonly T[],
): T[] {
  return tasks.filter((task) => task.followsBotModel === false && !sameModelSelection(task.modelSelection ?? botModel, botModel));
}
