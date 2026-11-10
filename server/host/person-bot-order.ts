// The order of a Team Cloud's bots is each person's own (`bot-orders.json`): a User's reorder changes only their list.
// Whoever has never ordered theirs sees the team's order, the one an Owner or Admin sets (the fleet's own order).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { reorderStable } from "../../shared/bot-order.ts";
import { writeFileAtomic } from "../atomic.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";

const BOT_ORDERS_FILE = "bot-orders.json";
const fileSchema = z.object({ version: z.literal(1), orders: z.record(z.string(), z.array(z.string())) });

export function createPersonBotOrder(dataDir: string) {
  const file = join(dataDir, BOT_ORDERS_FILE);
  let orders: Record<string, string[]> = {};
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) orders = parsed.data.orders;
    else console.warn(`bot orders: ${file} is not a bot orders file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`bot orders: ${file} is unreadable; starting fresh`);
  }
  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, orders })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`bot orders: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /** The team's bots as this person orders them: the bots they ordered keep their order among the places those bots hold
   * in the team's; a bot made since keeps its place in the team's. */
  function ordered<T extends { id: string }>(person: string, bots: readonly T[]): T[] {
    const own = orders[person];
    return own ? reorderStable(bots, own) : [...bots];
  }
  /** A `bots.order` frame as this person's own list; null when it is theirs as it is. */
  function ownOrderFrame(person: string, payload: Record<string, unknown>): Record<string, unknown> | null {
    if (payload.kind !== "bots.order" || !orders[person] || !Array.isArray(payload.botIds)) return null;
    const botIds = payload.botIds.filter((id): id is string => typeof id === "string");
    const own = ordered(person, botIds.map((id) => ({ id }))).map((bot) => bot.id);
    return own.every((id, index) => id === botIds[index]) ? null : { ...payload, botIds: own };
  }
  return {
    ordered,
    /** A stable partial reorder of this person's own list (shared/bot-order.ts); the whole list is kept as theirs. */
    reorder<T extends { id: string }>(person: string, bots: readonly T[], botIds: readonly string[]): T[] {
      const next = reorderStable(ordered(person, bots), botIds);
      orders[person] = next.map((bot) => bot.id);
      save();
      return next;
    },
    ownOrderFrame,
    /** Whose own order a request reads and writes: a User's; null for an Owner's or Admin's, whose order is the team's. */
    personOf: (auth: RequestAuth): string | null => (auth.kind === "session" && !auth.scopes.includes("admin") ? personKey(auth.session) : null),
    /** A `bots.order` frame as a User's stream should get it; null when it goes as it is (an admin's stream included). */
    streamFrame(client: { person?: { id: string; email?: string }; admin: boolean }, payload: Record<string, unknown>): Record<string, unknown> | null {
      return client.person && !client.admin ? ownOrderFrame(personKey(client.person), payload) : null;
    },
    forgetPerson(person: string): void {
      if (!orders[person]) return;
      delete orders[person];
      save();
    },
  };
}

export type PersonBotOrder = ReturnType<typeof createPersonBotOrder>;
