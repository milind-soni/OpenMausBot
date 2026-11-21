import { use, useContext, useMemo, useSyncExternalStore } from "react";

import type { AppState, Message } from "@/state/store";
import { StoreContext, StoreSourceContext } from "@/state/store-context";
import { findEditSource, isComparableTextName, type EditSource } from "./edit-source";
import type { TranscriptFileAttachment } from "./composer-attachments";

const noSubscription = () => () => {};
const NONE: ReadonlyMap<string, EditSource> = new Map();

function threadMessages(state: AppState, threadId: string): readonly Message[] | null {
  if (state.forkPanel?.threadId === threadId) return state.forkPanel.messages;
  return state.bots.find((bot) => bot.threadId === threadId)?.messages ?? state.groups.find((group) => group.threadId === threadId)?.messages ?? null;
}

const encode = (found: Map<string, EditSource>) => [...found].map(([path, source]) => [path, source.messageId, source.path, source.name].join("\u0000")).join("\n");

/** The person's attached file each of a reply's returned text files is an edit of (edit-source.ts), followed in the
 * store as one string so a gallery renders again only when the answer changes. Outside a store there is none. */
export function useEditSources(message: { threadId: string; messageId: string } | undefined, files: readonly TranscriptFileAttachment[]): ReadonlyMap<string, EditSource> {
  const source = useContext(StoreSourceContext);
  const scoped = use(StoreContext);
  const eligible = message ? files.filter((file) => file.private && isComparableTextName(file.name)) : [];
  const read = () => {
    if (!message || !eligible.length) return "";
    const state = source ? source.getState() : scoped?.state;
    const messages = state && threadMessages(state, message.threadId);
    return messages ? encode(findEditSource(messages, message.messageId, eligible)) : "";
  };
  const key = useSyncExternalStore(source?.subscribe ?? noSubscription, read, read);
  return useMemo(() => {
    if (!key) return NONE;
    return new Map(key.split("\n").map((row) => {
      const [path, messageId, original, name] = row.split("\u0000") as [string, string, string, string];
      return [path, { messageId, path: original, name }];
    }));
  }, [key]);
}
