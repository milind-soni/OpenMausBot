// The page the person has open in the chat's page pane while they type, so the bot knows which page "this" means.
// The title is the page's own word, so it reaches the model only inside a records block.
import { z } from "zod";

import { appRow } from "./chat-apps.ts";
import type { AgentCardStore } from "./chat-widgets.ts";
import { clean, recordsBlock } from "./records-block.ts";

const shape = z.object({
  appId: z.string().regex(/^[\w-]{1,128}$/),
  rev: z.number().int().min(0).max(1_000_000),
}).strict();

export const OPEN_PAGE_BAD = "openPage must name a page in this conversation: { appId, rev }.";

/** null when no page is open or it is gone; false when the value is malformed. */
export function openPageBlock(store: Pick<AgentCardStore, "messagesFor">, threadId: string, value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  const parsed = shape.safeParse(value);
  if (!parsed.success) return false;
  const { appId, rev } = parsed.data;
  const row = appRow(store, threadId, appId);
  // A page deleted or replaced since the pane opened is no reason to refuse what the person typed.
  if (!row || row.app.source !== "html") return null;
  const current = (row.app.rev ?? 0) + 1;
  const viewing = Math.min(rev + 1, current);
  return [
    `The person had your page open in a large view beside the chat while writing this message, so "this" or "the page" most likely means it. Page app_id "${appId}" (now version ${current}); the person was looking at version ${viewing}. To change it, call show_html with that app_id.`,
    recordsBlock("the open page's title", [clean(row.app.title, 80)]),
  ].join("\n") + "\n\n";
}
