// What each person signed in to a self-hosted server chose to be called, in <data>/person-names.json by their person key:
// their sign-in address, or the device's own session when it has none. The server's profile stays the owner's name.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { personKey } from "../person-key.ts";
import type { PersonName } from "../replies.ts";
import type { SessionRecord } from "../sessions.ts";

export const DISPLAY_NAME_MAX = 60;

type Person = Pick<SessionRecord, "id" | "email">;

/** The name as kept, or null when it is empty, longer than DISPLAY_NAME_MAX characters, or holds a control character. */
export function cleanDisplayName(raw: string): string | null {
  const name = raw.trim();
  const length = [...name].length;
  return length >= 1 && length <= DISPLAY_NAME_MAX && !/\p{Cc}/u.test(name) ? name : null;
}

export interface PersonNames {
  of(session: Person): string | null;
  /** By the key on a message's sender. */
  byKey(person: string | undefined): string | null;
  /** null clears the name. */
  save(session: Person, name: string | null): void;
  /** What people's lines are called in a turn: each chosen name by its line's sender, otherwise `fallback`. */
  lineNames(fallback: string): PersonName;
}

export function createPersonNames(dataDir: string): PersonNames {
  const file = join(dataDir, "person-names.json");
  const names = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { names?: Record<string, unknown> };
    for (const [person, name] of Object.entries(raw.names ?? {})) {
      const clean = typeof name === "string" ? cleanDisplayName(name) : null;
      if (clean) names.set(person, clean);
    }
  } catch { /* none chosen yet */ }

  const byKey = (person: string | undefined) => (person ? names.get(person) ?? null : null);
  return {
    of: (session) => byKey(personKey(session)),
    byKey,
    save(session, name) {
      if (name === null) names.delete(personKey(session));
      else names.set(personKey(session), name);
      writeFileAtomic(file, `${JSON.stringify({ v: 1, names: Object.fromEntries(names) }, null, 2)}\n`, { mode: 0o600 });
    },
    lineNames: (fallback) => (names.size ? (line) => byKey(line.sender?.id) ?? fallback : fallback),
  };
}
