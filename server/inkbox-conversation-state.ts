import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { parseChannelConversationState } from "./channel-conversation.ts";

export interface InkboxConversationBinding { identityId: string; botId: string; ownerPhone: string; phoneNumberId: string | null }
const bindingSchema = z.object({ identityId: z.string().min(1), botId: z.string().min(1), ownerPhone: z.string().min(1), phoneNumberId: z.string().min(1).nullable() }).strict();
const stateFile = (root: string, binding: string) => join(root, createHash("sha256").update(binding).digest("hex"), "conversation.json");

/** Keep the legacy no-phone path stable while setup discovers its phone resource.
 * The saved binding still pins that resource: only null -> known may migrate.
 * This runs while replacing a drained channel, never alongside another writer.
 * Ambiguous files are preserved for inspection, never merged or replayed. */
export function prepareInkboxConversationState(root: string, value: InkboxConversationBinding | null): { file: string; binding: string; stateUnavailable?: boolean } {
  const binding = JSON.stringify(value);
  const file = stateFile(root, JSON.stringify(value ? { ...value, phoneNumberId: null } : null));
  const result = { file, binding };
  try {
    const candidates = [...new Set([file, stateFile(root, binding)])].filter(existsSync);
    if (candidates.length > 1) throw new Error("Ambiguous conversation state");
    const source = candidates[0];
    if (!source) return result;
    if (statSync(source).size > 256 * 1024) throw new Error("Oversized conversation state");
    const state = parseChannelConversationState(JSON.parse(readFileSync(source, "utf8")));
    if (value) {
      const saved = bindingSchema.parse(JSON.parse(state.binding));
      if (saved.identityId !== value.identityId || saved.botId !== value.botId || saved.ownerPhone !== value.ownerPhone ||
          (saved.phoneNumberId !== null && saved.phoneNumberId !== value.phoneNumberId)) throw new Error("Different conversation binding");
    } else if (state.binding !== binding) throw new Error("Different conversation binding");
    if (source !== file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // Atomic move retires the old path; a copied stale snapshot would become
      // ambiguous after the next turn. A crash leaves exactly one owner file.
      renameSync(source, file);
    }
    if (state.binding !== binding) writeFileAtomic(file, JSON.stringify({ ...state, binding }), { mode: 0o600 });
    return result;
  } catch {
    return { ...result, stateUnavailable: true };
  }
}
