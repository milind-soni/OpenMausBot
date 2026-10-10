// The HTTP boundary of a message's Data context (shared/data-context.ts):
// a card id as the sheet mints them and a bounded draft, or a 400.
import { z } from "zod";

import type { DataContext } from "../shared/data-context.ts";

export type { DataContext };

/** A draft is one editor's contents; anything larger is not a draft. */
export const DATA_CONTEXT_DRAFT_MAX_BYTES = 100 * 1024;

const dataContextSchema = z.object({
  cardId: z.string().regex(/^c_\d+$/),
  draftSql: z.string().refine((draft) => Buffer.byteLength(draft) <= DATA_CONTEXT_DRAFT_MAX_BYTES, "draftSql is too large").optional(),
}).strict();

/** Parse an optional `dataContext` from a messages POST body. */
export function parseDataContext(value: unknown): DataContext | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = dataContextSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error("dataContext must name a Data card (c_<n>) with an optional draftSql of at most 100 KB"), { status: 400 });
  }
  return parsed.data;
}
