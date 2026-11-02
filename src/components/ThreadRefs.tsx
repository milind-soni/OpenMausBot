import { MentionText } from "./MentionText";
import type { MentionPeer } from "@/lib/mentions";
import { createContext, Fragment, useContext, useMemo, useRef, type ReactNode } from "react";
import { botOpensTo, openBot, openThread, useStore, type Action, type AppState, type Bot, type Group, type ThreadTarget } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { useStoreRef } from "@/state/store-ref";
import { t } from "@/lib/i18n";
import { parseBotRefUrl, parseThreadRefUrl, resolveThreadRefAddress, splitThreadRefsForDisplay, type ThreadRefCandidate } from "@/lib/thread-refs";

export interface ThreadRefsValue {
  threads: ThreadRefCandidate[];
  currentBotId?: string;
}

export const ThreadRefsContext = createContext<ThreadRefsValue>({ threads: [] });

export function useThreadRefs(): ThreadRefsValue {
  return useContext(ThreadRefsContext);
}

export function collectThreadRefs(
  bots: ReadonlyArray<Pick<Bot, "id" | "name" | "tasks">>,
  groups: ReadonlyArray<Pick<Group, "id" | "name" | "tasks" | "dm">>,
): ThreadRefCandidate[] {
  const refs: ThreadRefCandidate[] = [];
  for (const bot of bots) {
    for (const task of bot.tasks ?? []) {
      refs.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, title: task.title, activeAt: task.createdAt });
    }
  }
  for (const group of groups) {
    if (group.dm) continue;
    for (const task of group.tasks ?? []) {
      refs.push({ botId: group.id, botName: group.name, threadId: task.threadId, title: task.title, activeAt: task.createdAt });
    }
  }
  return refs;
}

const signatureOf = (refs: ThreadRefCandidate[]) =>
  refs.map((ref) => `${ref.botId}\u0000${ref.threadId}\u0000${ref.title}\u0000${ref.activeAt ?? ""}\u0000${ref.botName}`).join("\u0001");

export function ThreadRefsProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const next = collectThreadRefs(state.bots, state.groups);
  const signature = signatureOf(next);
  const cache = useRef({ signature, threads: next });
  if (cache.current.signature !== signature) cache.current = { signature, threads: next };
  const threads = cache.current.threads;
  const currentBotId = state.selectedId;
  const value = useMemo(() => ({ threads, currentBotId }), [threads, currentBotId]);
  return <ThreadRefsContext.Provider value={value}>{children}</ThreadRefsContext.Provider>;
}

export interface ThreadLinkTarget extends ThreadTarget {
  title: string;
  botName: string;
}

export function ThreadLink({ target, ambiguous, children }: { target: ThreadLinkTarget; ambiguous: boolean; children?: ReactNode }) {
  const store = useStoreRef();
  const showThreads = useShowThreads();
  return (
    <button
      type="button"
      data-thread-link={target.threadId}
      onClick={() => openThread(store.dispatch, target, store.state(), showThreads)}
      title={ambiguous ? t("chat.openThreadOn", { title: target.title, name: target.botName }) : t("chat.openThread", { title: target.title })}
      className="inline break-words text-start text-accent underline decoration-accent/40 hover:decoration-accent"
    >
      {children}
    </button>
  );
}

/** Security: a link from outside the app only navigates. */
export function openChatLink(dispatch: (action: Action) => void, link: string, state: AppState, threadsShown: boolean): boolean {
  const openOwner = (id: string) => {
    const bot = state.bots.find((candidate) => candidate.id === id);
    if (bot) {
      openBot(dispatch, bot, threadsShown);
      return { name: bot.name, threadId: botOpensTo(bot, threadsShown) };
    }
    const room = state.groups.find((group) => group.id === id && !group.dm);
    if (room) dispatch({ type: "select", id: room.id });
    return room && { name: room.name, threadId: room.threadId };
  };
  const ownerAddress = parseBotRefUrl(link);
  if (ownerAddress) {
    const owner = openOwner(ownerAddress.botId);
    if (owner) {
      if (owner.threadId) dispatch({ type: "revealThread", threadId: owner.threadId });
      return true;
    }
    showLinkNotice(dispatch, state, { kind: "bot-gone", botName: null });
    return false;
  }
  const address = parseThreadRefUrl(link);
  const ref = address ? resolveThreadRefAddress(collectThreadRefs(state.bots, state.groups), address) : null;
  if (ref) return openThread(dispatch, ref, state, threadsShown);
  const owner = address?.botId ? openOwner(address.botId) : undefined;
  if (owner) {
    dispatch({ type: "notice", notice: { kind: "thread-gone", botName: owner.name } });
  } else {
    showLinkNotice(dispatch, state, { kind: "thread-gone", botName: null });
  }
  return false;
}

function showLinkNotice(dispatch: (action: Action) => void, state: AppState, notice: NonNullable<AppState["notice"]>) {
  if (state.activeView !== "chat" && state.selectedId) dispatch({ type: "select", id: state.selectedId });
  dispatch({ type: "notice", notice });
}

export function threadLinkFromProps(props: Record<string, unknown>): { target: ThreadLinkTarget; ambiguous: boolean } | null {
  const threadId = props["data-thread-id"];
  if (typeof threadId !== "string") return null;
  const text = (key: string) => {
    const value = props[key];
    return typeof value === "string" ? value : "";
  };
  return {
    target: { threadId, botId: text("data-thread-bot"), title: text("data-thread-title"), botName: text("data-thread-bot-name") },
    ambiguous: props["data-thread-ambiguous"] === "true",
  };
}

export function ThreadRefText({ text, peers, everyone = false }: {
  text: string; peers?: readonly MentionPeer[]; everyone?: boolean;
}) {
  const { threads, currentBotId } = useThreadRefs();
  const spans = useMemo(() => splitThreadRefsForDisplay(text, threads, currentBotId), [text, threads, currentBotId]);
  const plain = (run: string, key: number) =>
    peers ? <MentionText key={key} text={run} peers={peers} everyone={everyone} /> : <Fragment key={key}>{run}</Fragment>;
  if (!spans.some((span) => span.ref)) return plain(text, 0);
  return (
    <>
      {spans.map((span, index) => (span.ref
        ? <ThreadLink key={index} target={span.ref} ambiguous={span.ref.ambiguous}>{span.text}</ThreadLink>
        : plain(span.text, index)))}
    </>
  );
}
