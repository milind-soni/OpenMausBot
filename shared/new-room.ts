import type { GroupDefaultResponder } from "./wire.ts";

/** The longest room name the server takes. */
export const ROOM_NAME_MAX = 100;
const NAMED = 3;

/** Who answers a plain message in a room made with these bots: the decision model when it is on, else the first bot. */
export function newRoomResponder(memberIds: readonly string[], deciderOn: boolean): GroupDefaultResponder {
  const first = memberIds[0];
  if (!first) return { kind: "mentions" };
  return deciderOn && memberIds.length > 1 ? { kind: "auto", fallbackBotId: first } : { kind: "member", botId: first };
}

function listed(names: readonly string[]): string {
  const shown = names.slice(0, NAMED);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} +${rest}`;
  return shown.length < 2 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} & ${shown.at(-1)}`;
}

/** A room's name from its bots ("Otto, Juniper & Pepper"), numbered when another room already has it. */
export function newRoomName(botNames: readonly string[], taken: readonly string[] = []): string {
  const names = botNames.map((name) => name.replace(/\s+/g, " ").trim()).filter(Boolean);
  let base = listed(names);
  for (let count = Math.min(names.length, NAMED); base.length > ROOM_NAME_MAX - 4 && count > 1; count -= 1) {
    base = `${names.slice(0, count - 1).join(", ")} +${names.length - count + 1}`;
  }
  base = base.slice(0, ROOM_NAME_MAX - 4).trim();
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}
