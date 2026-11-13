// A Chief already in charge of every department gets each new department too, added to its managedSections the way the
// owner's tick under "Also in charge of" adds one: the same store write, the same bot update every client sees, and a
// bot.update row in the admin activity log for the request that made the department. A Chief in charge of only some
// departments gets nothing, and the owner can untick any department afterwards. Chiefs someone owns on a Team Cloud are
// never counted (inChargeOfEvery), so this never widens what a member's Chief can reach.
import { AsyncLocalStorage } from "node:async_hooks";

import { inChargeOfEvery } from "./peer-roster.ts";
import type { Store } from "./store.ts";

export interface DepartmentGrant { id: string; name: string; before: string[]; after: string[] }

/** What one request's new departments gave which Chiefs, for that request's admin activity rows (server/index.ts). */
export const departmentGrants = new AsyncLocalStorage<DepartmentGrant[]>();

/** The settings page saves at most this many departments for one Chief (server/routes/bot-patch.ts). */
const MAX_MANAGED = 100;

/** `added` just joined the departments. Who qualifies is read now, from the bots as they were before the write that
 * made the department (a bot made Chief by that same write does not count); the grant waits until that write is done,
 * since it may still be saving a copy of the bots, and goes only to a Chief that still qualifies then. */
export function grantNewDepartments(store: Pick<Store, "sections" | "bots" | "bot" | "patchBot">, added: readonly string[]): void {
  const before = store.sections.filter((name) => !added.includes(name));
  const chiefs = store.bots.filter((bot) => inChargeOfEvery(bot, before)).map((bot) => bot.id);
  if (!chiefs.length) return;
  void Promise.resolve().then(() => {
    for (const id of chiefs) {
      const chief = store.bot(id);
      if (!chief || !inChargeOfEvery(chief, before)) continue;
      const previous = [...chief.managedSections!];
      const managedSections = [...new Set([...previous, ...added])];
      if (managedSections.length === previous.length || managedSections.length > MAX_MANAGED) continue;
      try {
        store.patchBot(chief.id, { managedSections });
        departmentGrants.getStore()?.push({ id: chief.id, name: chief.name, before: previous, after: managedSections });
      } catch (error) {
        console.warn(`[teams] Could not add the new department to ${chief.name}: ${(error as Error).message}`);
      }
    }
  });
}
