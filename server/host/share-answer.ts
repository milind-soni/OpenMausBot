// Whether a bot's answer to one requester may also answer another requester's same request (the coordinator's
// shareAnswer): only where the same people see both requesters' conversations, and only when the bot works on both in
// the same folder, since a question about files is answered from the files there. A conversation's own private folder
// starts with nothing of either requester's, so two of those count as one.
import { sep } from "node:path";

import type { HandoffView } from "../coordinator.ts";

export interface ShareAnswerDeps {
  /** The conversation a request came from (its requester's), if it is known. */
  askedFrom(node: HandoffView): string | undefined;
  audienceOf(threadId: string): string;
  /** The folder pinned to a bot's conversation: a path, null for its own private folder, undefined while unpinned. */
  pinned(botId: string, threadId: string): string | null | undefined;
  /** The bot's project folder, which an unpinned conversation takes. */
  botFolder(botId: string): string | undefined;
  /** Where conversations' own private folders live. */
  privateFolders: string;
}

export function createShareAnswer(deps: ShareAnswerDeps): (first: HandoffView, joiner: HandoffView) => boolean {
  const folder = (node: HandoffView): string | null => {
    const pinned = deps.pinned(node.botId, node.threadId);
    const cwd = pinned === undefined ? deps.botFolder(node.botId) ?? null : pinned;
    return cwd && !cwd.startsWith(deps.privateFolders + sep) ? cwd : null;
  };
  return (first, joiner) => {
    const a = deps.askedFrom(first), b = deps.askedFrom(joiner);
    return a !== undefined && b !== undefined && deps.audienceOf(a) === deps.audienceOf(b) && folder(first) === folder(joiner);
  };
}
