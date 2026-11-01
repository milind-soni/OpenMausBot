// The language each person's app shows, from its presence pings (src/hooks/use-presence.ts), so the lines the server
// writes for a person read in it (server/server-lines.ts). The app keeps a person's language pick on their own computer,
// so this is the only way the server learns it. Kept on disk: a routine's line at night, with no app open, still knows.
// A line for nobody in particular reads in the place's language: the one set on this server or by the team's Admin,
// else the one most people's apps here show.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import type { LineLanguage } from "../server-lines.ts";

export const PERSON_LANGUAGES_FILE = "person-languages.json";
/** Pings from this computer's own app carry no session; they are kept under this key. */
export const THIS_COMPUTER = "this-computer";
const MAX_PEOPLE = 500;
const TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;
const fileSchema = z.object({
  version: z.literal(1),
  people: z.record(z.string().min(1).max(200), z.object({ language: z.string().regex(TAG), at: z.number() })),
});

export interface PersonLanguagesDeps {
  dataDir: string;
  /** The language set on this server, else the team's default from the Admin. */
  configured(): string | undefined;
  now?: () => number;
}

export function createPersonLanguages(deps: PersonLanguagesDeps) {
  const file = join(deps.dataDir, PERSON_LANGUAGES_FILE);
  const now = deps.now ?? Date.now;
  const people = new Map<string, { language: string; at: number }>();
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) for (const [person, heard] of Object.entries(parsed.data.people)) people.set(person, heard);
    else console.warn(`person languages: ${file} is not a languages file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`person languages: ${file} is unreadable; starting fresh`);
  }

  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, people: Object.fromEntries(people) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`person languages: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The language most people's apps here show; on a tie, the one heard most lately. */
  const usual = (): string | undefined => {
    const counts = new Map<string, { people: number; at: number }>();
    for (const { language, at } of people.values()) {
      const count = counts.get(language);
      counts.set(language, { people: (count?.people ?? 0) + 1, at: Math.max(count?.at ?? 0, at) });
    }
    return [...counts].sort(([, a], [, b]) => b.people - a.people || b.at - a.at)[0]?.[0];
  };

  const forLine: LineLanguage = (person) => (person ? people.get(person)?.language : undefined) ?? deps.configured() ?? usual();

  return {
    /** A presence ping from this person's app: the language it shows. Written down only when it changes. */
    heard(person: string, language: string): void {
      const tag = language.trim().toLowerCase();
      if (!person || !TAG.test(tag)) return;
      const known = people.get(person);
      if (known?.language === tag) {
        known.at = now();
        return;
      }
      people.delete(person);
      people.set(person, { language: tag, at: now() });
      if (people.size > MAX_PEOPLE) people.delete(people.keys().next().value!);
      save();
    },
    forLine,
  };
}

export type PersonLanguages = ReturnType<typeof createPersonLanguages>;
