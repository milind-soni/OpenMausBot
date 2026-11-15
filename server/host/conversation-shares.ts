// On a Team Cloud a private conversation is shared only by the person it is private to: with the team, when it becomes
// the team's (audience `team`), or with one teammate. A conversation shared with one person has an audience of its own,
// `member:<share key>`, the key made from the conversation and held by no session: its memory layer, engine home and
// browser are its own, so neither person's private notes reach it, and nobody but its two readers (never an admin) sees
// it. Security invariant: a share is never undone into a narrower audience by anyone's request; only someone leaving the
// team dissolves one with one reader, into a private chat of the reader who stays.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { memberAudience, type Audience } from "../audience.ts";

export const CONVERSATION_SHARES_FILE = "conversation-shares.json";
const MAX_SHARES = 50_000;

const person = z.string().regex(/^p_[\w-]{22}$/);
const shareSchema = z.object({ owner: person, with: z.union([z.literal("team"), person]), at: z.number(), before: z.object({ with: person, at: z.number() }).optional() });
const fileSchema = z.record(z.string().regex(/^[\w-]{1,128}$/), shareSchema);

export type ConversationShare = z.infer<typeof shareSchema>;

export function shareKey(threadId: string): string {
  return `p_${createHash("sha256").update(`conversation:${threadId}`).digest("base64url").slice(0, 22)}`;
}

/** What someone leaving did to a share with one reader: the conversation is now `to`'s private chat. */
export interface DissolvedShare { threadId: string; to: string }

export function createConversationShares(deps: { dataDir: string; team: boolean }) {
  const file = join(deps.dataDir, CONVERSATION_SHARES_FILE);
  let shares: Record<string, ConversationShare> = {};
  if (deps.team) {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) shares = parsed.data;
      else console.warn(`conversation shares: ${file} is not a shares file; nothing is shared`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`conversation shares: ${file} is unreadable; nothing is shared`);
    }
  }
  const keys = () => new Set(Object.entries(shares).filter(([, share]) => share.with !== "team").map(([threadId]) => shareKey(threadId)));
  let shareKeys = keys();
  const save = () => {
    const entries = Object.entries(shares);
    if (entries.length > MAX_SHARES) shares = Object.fromEntries(entries.slice(-MAX_SHARES));
    shareKeys = keys();
    writeFileAtomic(file, `${JSON.stringify(shares)}\n`, { mode: 0o600 });
  };

  return {
    get(threadId: string): ConversationShare | undefined {
      return deps.team ? shares[threadId] : undefined;
    },
    /** The audience sharing gave the conversation; null when it was never shared. */
    audienceOf(threadId: string): Audience | null {
      const share = deps.team ? shares[threadId] : undefined;
      if (!share) return null;
      return share.with === "team" ? "team" : memberAudience(shareKey(threadId));
    },
    /** Who reads a conversation shared with one person: its owner and that person. Null for any other conversation. */
    readers(threadId: string): readonly string[] | null {
      const share = deps.team ? shares[threadId] : undefined;
      return share && share.with !== "team" ? [share.owner, share.with] : null;
    },
    /** A share key names a conversation, never a person: no About you, no inbox, no own connections. */
    isShareKey(key: string): boolean {
      return shareKeys.has(key);
    },
    /** A task as one person is sent it: marked shared, and when shared with one person, who the other reader is. */
    forViewer<T extends { threadId: string }>(task: T, viewer: string, nameOf: (person: string) => string | undefined): T {
      const share = deps.team ? shares[task.threadId] : undefined;
      if (!share) return task;
      if (share.with === "team") return { ...task, shared: true };
      const byYou = share.owner === viewer;
      const other = byYou ? share.with : share.owner;
      return { ...task, shared: true, sharedWith: { name: nameOf(other) ?? "", ...(byYou ? { byYou: true } : {}) } };
    },
    /** Whether a notification about the conversation reaches this person: one from before it was shared with them was
     * its owner's alone, and stays so. */
    reaches(entry: { threadId?: string; at: number }, person: string | null): boolean {
      const share = deps.team && entry.threadId ? shares[entry.threadId] : undefined;
      if (!share || entry.at >= share.at || person === share.owner) return true;
      return Boolean(share.before && person === share.before.with && entry.at >= share.before.at);
    },
    share(threadId: string, owner: string, to: "team" | string, at = Date.now()): ConversationShare {
      const earlier = shares[threadId];
      const before = earlier && earlier.with !== "team" ? { with: earlier.with, at: earlier.at } : undefined;
      const share = shareSchema.parse({ owner, with: to, at, ...(before ? { before } : {}) });
      shares[threadId] = share;
      save();
      return share;
    },
    /** Someone left: a conversation they shared with one person becomes that person's, one shared with them becomes its
     * owner's again. What was shared with the team stays the team's. */
    personLeft(key: string): DissolvedShare[] {
      const dissolved: DissolvedShare[] = [];
      for (const [threadId, share] of Object.entries(shares)) {
        if (share.with === "team" || (share.owner !== key && share.with !== key)) continue;
        dissolved.push({ threadId, to: share.owner === key ? share.with : share.owner });
        delete shares[threadId];
      }
      if (dissolved.length) save();
      return dissolved;
    },
    forget(threadIds: readonly string[]): void {
      const known = threadIds.filter((threadId) => Object.hasOwn(shares, threadId));
      for (const threadId of known) delete shares[threadId];
      if (known.length) save();
    },
  };
}

export type ConversationShares = ReturnType<typeof createConversationShares>;
