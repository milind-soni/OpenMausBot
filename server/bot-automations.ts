// A bot's schedules, webhooks, app events and waits live and die with it, however the bot is deleted.
import type { AppTriggerManager } from "./app-triggers.ts";
import type { RoutineManager } from "./routines.ts";
import type { WaitManager } from "./waits.ts";
import type { WebhookManager } from "./webhooks.ts";

interface Automations {
  routines: Pick<RoutineManager, "removeForBot" | "listRoutines" | "listRuns">;
  webhooks: Pick<WebhookManager, "removeForBot" | "list">;
  /** App events: removing one also releases its watch on the connected-apps service. */
  apps?: Pick<AppTriggerManager, "list" | "remove">;
  waits?: Pick<WaitManager, "removeForBot" | "owners">;
}

interface Bots {
  readonly bots: readonly { id: string }[];
  bot(id: string): unknown;
  onChange(listener: (change: { type: string; botId?: string }) => void): unknown;
}

function removeFor(botId: string, automations: Automations): void {
  for (const remove of [() => automations.routines.removeForBot(botId), () => automations.webhooks.removeForBot(botId), () => automations.waits?.removeForBot(botId)]) {
    // A save that fails here leaves an orphan that never runs; the next start removes it.
    try { remove(); } catch (error) { console.error(`automations: could not remove deleted bot ${botId}'s automations yet`, error); }
  }
  for (const trigger of automations.apps?.list().filter((candidate) => candidate.botId === botId) ?? []) {
    automations.apps!.remove(trigger.id).catch((error: unknown) => console.error(`automations: could not remove deleted bot ${botId}'s app event yet`, error));
  }
}

/** Removes automations whose bot is already gone, then each deleted bot's from now on. With no bot loaded at all nothing
 * is removed at start, so an unreadable bots.json never reads as "every bot was deleted". */
export function tieAutomationsToBots(store: Bots, automations: Automations): void {
  if (store.bots.length) {
    const owners = [...automations.routines.listRoutines(), ...automations.routines.listRuns(), ...automations.webhooks.list(), ...automations.apps?.list() ?? []];
    for (const botId of new Set([...owners.map((owner) => owner.botId), ...automations.waits?.owners() ?? []])) if (!store.bot(botId)) removeFor(botId, automations);
  }
  store.onChange((change) => {
    if (change.type === "bot.deleted" && change.botId) removeFor(change.botId, automations);
  });
}
