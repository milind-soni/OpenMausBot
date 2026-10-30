// watch_list's arguments, as the agents bridge checks them before the call and the server checks them again: something
// a bot keeps an eye on for the person until it settles.
export const WATCH_LIMITS = { title: 120, note: 400, source: 300, outcome: 300, id: 64 } as const;

export type WatchInput =
  | { action: "track"; title: string; note: string; source?: string; checkAfter?: number }
  | { action: "update"; id: string; note: string; checkAfter?: number }
  | { action: "resolve"; id: string; outcome: string };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const line = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

function checkAfter(value: unknown): { ok: true; at?: number } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true };
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? { ok: true, at } : { ok: false };
}

/** The tool's arguments as one change to the list, or what is wrong with them in one sentence. */
export function parseWatchInput(value: unknown): { ok: true; value: WatchInput } | { ok: false; error: string } {
  if (!record(value)) return { ok: false, error: "watch_list takes action: track, update or resolve." };
  const id = line(value.id), note = line(value.note), after = checkAfter(value.check_after);
  if (!after.ok) return { ok: false, error: "check_after: a date or date and time, such as 2026-11-02 or 2026-11-02T09:00:00Z." };
  const later = after.at === undefined ? {} : { checkAfter: after.at };
  const needsId = (): string | null => (id && id.length <= WATCH_LIMITS.id ? null : "id: the item's id, as your watch list shows it.");
  const noteRefused = (): string | null => (note && note.length <= WATCH_LIMITS.note ? null : `note: at most ${WATCH_LIMITS.note} characters on where it stands now.`);
  switch (value.action) {
    case "track": {
      const title = line(value.title), source = line(value.source);
      if (!title || title.length > WATCH_LIMITS.title) return { ok: false, error: `title: one line of at most ${WATCH_LIMITS.title} characters naming what you are watching.` };
      const refused = noteRefused() ?? (source.length > WATCH_LIMITS.source ? `source: at most ${WATCH_LIMITS.source} characters, such as a link or a thread id.` : null);
      return refused ? { ok: false, error: refused } : { ok: true, value: { action: "track", title, note, ...(source ? { source } : {}), ...later } };
    }
    case "update": {
      const refused = needsId() ?? noteRefused();
      return refused ? { ok: false, error: refused } : { ok: true, value: { action: "update", id, note, ...later } };
    }
    case "resolve": {
      const outcome = line(value.outcome);
      const refused = needsId() ?? (outcome && outcome.length <= WATCH_LIMITS.outcome ? null : `outcome: at most ${WATCH_LIMITS.outcome} characters on how it settled.`);
      return refused ? { ok: false, error: refused } : { ok: true, value: { action: "resolve", id, outcome } };
    }
    default:
      return { ok: false, error: "action: track, update or resolve." };
  }
}
