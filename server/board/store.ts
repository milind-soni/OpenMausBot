// `board.json` in the data folder: the Team Board's items. A file that is missing or unreadable is an empty board, and an
// item that does not parse is left out, so one bad record never hides the rest.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { BOARD_LIMITS, type BoardItem } from "../../shared/board.ts";
import { writeFileAtomic } from "../atomic.ts";

export const BOARD_FILE = "board.json";

const id = z.string().min(1).max(200);
const itemSchema = z.looseObject({
  threadId: id, groupId: id,
  title: z.string().min(1).max(BOARD_LIMITS.titleMax),
  state: z.enum(["waiting", "ready", "working", "needs_person", "done", "failed", "cancelled"]),
  needs: z.array(id).max(BOARD_LIMITS.needsMax),
  labels: z.record(z.string(), z.string()),
  forBotId: id.optional(),
  holder: z.object({ botId: id, since: z.number() }).optional(),
  attempts: z.number().int().min(0),
  question: z.object({ text: z.string(), askedAt: z.number(), person: z.string().optional() }).optional(),
  result: z.string().optional(),
  createdBy: z.object({ kind: z.enum(["person", "bot"]), id: z.string(), name: z.string() }),
  createdAt: z.number(), updatedAt: z.number(),
});
const fileSchema = z.object({ version: z.literal(1), items: z.array(z.unknown()), repeats: z.array(z.unknown()).optional() });

export interface BoardFile {
  items: BoardItem[];
  /** Repeating items, kept as read until a version that knows them. */
  repeats: unknown[];
}

export function readBoardFile(file: string): BoardFile {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return { items: [], repeats: [] };
    const items = parsed.data.items.flatMap((candidate) => {
      const item = itemSchema.safeParse(candidate);
      return item.success ? [item.data as BoardItem] : [];
    });
    return { items, repeats: parsed.data.repeats ?? [] };
  } catch {
    return { items: [], repeats: [] };
  }
}

export function writeBoardFile(file: string, board: BoardFile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ version: 1, items: board.items, repeats: board.repeats }, null, 2), { mode: 0o600 });
}
