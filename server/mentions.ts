// Mention tokens (Phase 2 part 4, from the Overlay review): a reference to
// a bot, room, task, routine, skill, MCP server, connector or capture is
// written into stored prose (a routine's instructions, a delegation brief)
// as `@name [[omb:type:id]]`, so it survives renames and needs no lookup
// when it is written. At run time each token becomes one line with the id
// and a short summary, so a tool can act on the entity directly instead
// of searching for it by name. Unknown tokens are left as they are.

export const MENTION_TYPES = ["bot", "room", "task", "routine", "skill", "mcp", "connector", "capture", "file"] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

export interface Mention {
  type: MentionType;
  id: string;
  /** The `@name` the author wrote before the token, when there was one. */
  name?: string;
}

/** What the harness knows about one entity, one line. Null = unknown. */
export type MentionResolver = (mention: Mention) => string | null;

const TOKEN = /(?:@([^\s[\]]{1,80})\s+)?\[\[omb:([a-z]+):([\w.:@+~-]{1,200})\]\]/g;

/** Every token in the text, in order. */
export function findMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const type = m[2] as MentionType;
    if (!MENTION_TYPES.includes(type)) continue;
    out.push({ type, id: m[3]!, ...(m[1] ? { name: m[1] } : {}) });
  }
  return out;
}

/** Serialise a reference the way it is stored. */
export function mentionToken(type: MentionType, id: string, name?: string): string {
  return `${name ? `@${name.replace(/\s+/g, "-")} ` : ""}[[omb:${type}:${id}]]`;
}

/** The text with every known token expanded to one line, and a resolved
 * list appended once, so tools act on ids rather than on names. */
export function resolveMentions(text: string, resolve: MentionResolver): { text: string; resolved: Array<Mention & { summary: string }> } {
  const resolved: Array<Mention & { summary: string }> = [];
  const seen = new Set<string>();
  const replaced = text.replace(TOKEN, (whole, name: string | undefined, rawType: string, id: string) => {
    const type = rawType as MentionType;
    if (!MENTION_TYPES.includes(type)) return whole;
    const summary = resolve({ type, id, ...(name ? { name } : {}) });
    if (summary === null) return whole;
    const key = `${type}:${id}`;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ type, id, ...(name ? { name } : {}), summary });
    }
    return `${name ?? summary.split(" — ")[0]} (${type} ${id})`;
  });
  if (!resolved.length) return { text, resolved };
  const list = resolved.map((r) => `- ${r.type} ${r.id}: ${r.summary}`).join("\n");
  return { text: `${replaced}\n\n[References in these instructions, resolved by OpenMausBot; use the ids directly:\n${list}]`, resolved };
}
