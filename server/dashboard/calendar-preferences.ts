import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { OwnedFile } from "../atomic.ts";

export interface CalendarPreferencesStore {
  selected(userId: string, accountId: string): string[];
  save(userId: string, accountId: string, calendarIds: readonly string[]): void;
}

const fileSchema = z.object({
  version: z.literal(1),
  selections: z.record(z.string(), z.record(z.string(), z.array(z.string().min(1).max(512)).max(50))),
});

type Selections = Record<string, Record<string, string[]>>;

export function openCalendarPreferencesStore(path = ":memory:"): CalendarPreferencesStore {
  const memoryOnly = path === ":memory:";
  const file = memoryOnly ? null : new OwnedFile(path, { mode: 0o600 });
  const selections: Selections = {};

  if (file) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = fileSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          Object.assign(selections, parsed.data.selections);
          file.loaded(raw);
        }
      } catch {}
    }
  }

  return {
    selected(userId, accountId) {
      return [...(selections[userId]?.[accountId] ?? [])];
    },
    save(userId, accountId, calendarIds) {
      const unique = [...new Set(calendarIds)];
      const nextAccount = { ...selections[userId] };
      if (unique.length === 0) {
        delete nextAccount[accountId];
      } else {
        nextAccount[accountId] = unique;
      }
      const nextSelections: Selections = { ...selections };
      if (Object.keys(nextAccount).length === 0) {
        delete nextSelections[userId];
      } else {
        nextSelections[userId] = nextAccount;
      }
      if (file) {
        file.write(`${JSON.stringify({ version: 1, selections: nextSelections }, null, 2)}\n`);
      }
      for (const key of Object.keys(selections)) delete selections[key];
      Object.assign(selections, nextSelections);
    },
  };
}
