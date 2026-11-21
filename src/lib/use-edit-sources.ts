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

const answers = new WeakMap<readonly Message[], Map<string, string>>();
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
    if (!messages) return "";
    // Asked again on every store change: answered once for each loaded conversation, reply and set of files.
    const asked = `${message.messageId}\n${eligible.map((file) => file.path).join("\n")}`;
    let known = answers.get(messages);
    if (!known) answers.set(messages, known = new Map());
    let answer = known.get(asked);
    if (answer === undefined) known.set(asked, answer = encode(findEditSource(messages, message.messageId, eligible)));
    return answer;
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
