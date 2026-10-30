import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export function loadPrivateDeliveryState<T>(dataDir: string, name: string, schema: z.ZodType<T>, empty: T): { state: T; unreadable: boolean; prepareSave(): boolean } {
  const file = join(dataDir, name);
  const warn = (problem: string) => console.warn(`private deliveries: ${file} ${problem}. Threads that cannot be classified without it stay private until it is repaired or removed.`);
  let unreadable = false;
  try {
    unreadable = readdirSync(dataDir).some((entry) => entry.startsWith(`${name}.unreadable-`));
    if (unreadable) warn("has unread evidence aside");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      unreadable = true;
      warn("has evidence that could not be listed");
    }
  }
  const invalid = (problem: string) => {
    let moved = false;
    const prepareSave = () => {
      if (moved) return true;
      const aside = `${file}.unreadable-${Date.now()}-${randomUUID()}`;
      try {
        renameSync(file, aside);
        moved = true;
        warn(`${problem}; moved to ${aside}`);
      } catch (error) {
        warn(`${problem} and could not be moved aside: ${error instanceof Error ? error.message : String(error)}`);
      }
      return moved;
    };
    prepareSave();
    return { state: empty, unreadable: true, prepareSave };
  };
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: empty, unreadable, prepareSave: () => true };
    return invalid("is unreadable");
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return invalid("is not valid JSON"); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return invalid("has an invalid schema");
  return { state: parsed.data, unreadable, prepareSave: () => true };
}

const id = z.string().min(1).max(200);
const person = z.string().regex(/^p_[\w-]{22}$/u);
const name = z.string().max(200);
const relay = z.object({ threadId: id, botId: id, originThreadId: id, from: person.nullable(), fromName: name, to: person, at: z.number() });
const waiting = z.object({ id, person, botId: id, threadId: id, messageId: id.optional(), from: name, fromEmail: z.string().max(320).optional(), text: z.string().max(400), at: z.number() });
const legacySchema = z.object({ version: z.literal(1), relays: z.array(relay).max(2_000), waiting: z.array(waiting).max(1_000) });

export function loadLegacyRelayState(dataDir: string) {
  return loadPrivateDeliveryState(dataDir, "team-messages.json", legacySchema, { version: 1, relays: [], waiting: [] });
}
