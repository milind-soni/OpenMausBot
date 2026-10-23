// What the person pointed at in a bot's page, handed to the bot with their message. Every field is the page's own
// word (its scripts can describe any element any way), so it reaches the model only inside a records block.
import { z } from "zod";

import type { AppPointedRef } from "../shared/app.ts";
import { POINT_LIMITS, pointedLabel } from "../shared/app-frame/point.ts";
import { appRow } from "./chat-apps.ts";
import type { AgentCardStore } from "./chat-widgets.ts";
import { clean, recordsBlock } from "./records-block.ts";

const part = z.object({
  appId: z.string().regex(/^[\w-]{1,128}$/),
  rev: z.number().int().min(0).max(1_000_000),
  tag: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  role: z.string().max(40),
  text: z.string().max(POINT_LIMITS.text * 2),
  selector: z.string().min(1).max(POINT_LIMITS.selector * 2),
  html: z.string().max(POINT_LIMITS.html * 2),
}).strict();
const parts = z.array(part).min(1).max(POINT_LIMITS.perMessage);

const BAD = `pointed must list 1 to ${POINT_LIMITS.perMessage} parts of a page in this conversation.`;
const NOTE = "While writing this message the person pointed at parts of your page. To change them, call update_html with that page's app_id.";

export type Pointed = { ok: true; block: string; refs: AppPointedRef[] } | { ok: false; status: 400 | 404; error: string };

/** Security invariant: a pick's words reach the model only through recordsBlock. null when nothing was pointed at. */
export function preparePointed(store: Pick<AgentCardStore, "messagesFor">, threadId: string, value: unknown): Pointed | null {
  if (value === undefined || value === null) return null;
  const parsed = parts.safeParse(value);
  if (!parsed.success) return { ok: false, status: 400, error: BAD };
  const byPage = new Map<string, Array<z.infer<typeof part>>>();
  for (const each of parsed.data) byPage.set(each.appId, [...(byPage.get(each.appId) ?? []), each]);
  const blocks: string[] = [];
  for (const [appId, picks] of byPage) {
    const row = appRow(store, threadId, appId);
    if (!row || row.app.source !== "html") return { ok: false, status: 404, error: "That page is not in this conversation." };
    const title = clean(row.app.title, 80);
    const current = (row.app.rev ?? 0) + 1;
    const versions = [...new Set(picks.map((pick) => pick.rev + 1))].map((version) => `version ${version}`).join(" and ");
    const lines = picks.map((pick, index) =>
      `${index + 1}. <${pick.tag}>${pick.role ? ` role ${pick.role}` : ""}; text: ${pick.text || "(none)"}; selector: ${pick.selector}; html: ${pick.html}`);
    blocks.push([
      `Page app_id "${appId}" (now version ${current}); the person was looking at ${versions}.`,
      recordsBlock(`the page "${title}", describing what the person pointed at`, lines),
    ].join("\n"));
  }
  return {
    ok: true,
    block: `${NOTE}\n${blocks.join("\n")}\n\n`,
    refs: parsed.data.map((pick) => ({ appId: pick.appId, label: pointedLabel(pick) ?? `<${pick.tag}>` })),
  };
}
