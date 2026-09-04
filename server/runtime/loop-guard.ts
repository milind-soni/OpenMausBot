// Noticing when the loop is going in circles.
//
// A model that calls the same tool with the same arguments over and over
// is not making progress, and every repeat costs a model call, a tool
// call, and the user's money. The hard caps (32 model calls, 64 tool
// calls) catch it eventually; this catches it early. Three identical calls
// inside a window of six is an advisory the model is told about — most
// models take the hint. Five identical is a stop.
//
// "Identical" is name plus arguments, serialized with sorted keys so two
// argument objects that differ only in key order compare equal.
export const REPEAT_WINDOW = 6;
export const REPEAT_ADVISORY_AT = 3;
export const REPEAT_STOP_AT = 5;

export type RepeatVerdict = "ok" | "advisory" | "stop";

export const REPEAT_ADVISORY_NOTE =
  "OpenMausBot: you have made this exact call several times. Its result will not change; use what you already have or try something different.";
export const REPEAT_STOP_NOTE = "OpenMausBot: stopping — the same call was repeated too many times without progress.";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface LoopGuard {
  /** Record one tool call and say whether the loop should carry on. */
  observe(name: string, args: unknown): RepeatVerdict;
  /** How many times the most recent call has been seen in total. */
  repeatsOfLast(): number;
}

export function createLoopGuard(): LoopGuard {
  const recent: string[] = [];
  const totals = new Map<string, number>();
  let last = "";

  return {
    observe(name, args) {
      const key = `${name}:${canonical(args)}`;
      last = key;
      recent.push(key);
      if (recent.length > REPEAT_WINDOW) recent.shift();
      const total = (totals.get(key) ?? 0) + 1;
      totals.set(key, total);
      if (total >= REPEAT_STOP_AT) return "stop";
      const inWindow = recent.filter((k) => k === key).length;
      return inWindow >= REPEAT_ADVISORY_AT ? "advisory" : "ok";
    },
    repeatsOfLast: () => totals.get(last) ?? 0,
  };
}
