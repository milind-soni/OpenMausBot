import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { useViewerEmail } from "@/lib/default-bot";
import { loadThroughMessage } from "@/lib/focus-message";
import { intlLocale, t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { useActiveLocale } from "@/lib/use-active-locale";
import { ApiError } from "@/state/api";
import { visibleMessages } from "@/state/snapshot-navigation";
import { api, type Bot, type Message } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { GoalRunCard, PinnedGoalSummary, goalRunStatus, goalRunTurnCount } from "./GoalRunCard";

type GoalMessage = Message & { kind: "goal.run" };
type Thread = Pick<Bot, "threadId" | "messages" | "hasMore">;
type GoalPage = { messages: Message[]; nextBefore: string | null };
type History = { goals: GoalMessage[]; before?: string | null; failed?: boolean };
const emptyHistory: History = { goals: [] };
const noDismissals = new Set<string>();

function readDismissals(key: string): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(saved)) return new Set(saved.filter((id): id is string => typeof id === "string"));
  } catch {}
  return noDismissals;
}

function isInactiveGoal(message: GoalMessage): boolean {
  return Boolean(message.goalRun && message.goalRun.status !== "working");
}

function isGoal(message: Message): message is GoalMessage {
  return message.kind === "goal.run";
}

function goalTitle(message: GoalMessage): string {
  return (message.goalRun?.goal ?? message.text)?.trim() || t("routines.goal.groupGoal");
}

function useGoalHistory({ threadId, messages, hasMore }: Thread, open: boolean) {
  const [history, setHistory] = useState(emptyHistory);
  const [readGeneration, setReadGeneration] = useState(0);
  const [live, setLive] = useState<ReadonlyMap<string, GoalMessage>>(() => new Map());
  const held = useMemo(() => messages.filter(isGoal), [messages]);
  const { before, failed } = history;
  const readPage = Boolean(hasMore && !failed && (before === undefined || (open && before !== null)));

  useEffect(() => listenLiveFrames({
    onFrame(frame) {
      if ((frame.kind !== "message" && frame.kind !== "message.patch") || frame.threadId !== threadId) return;
      const message = frame.message as Message;
      if (isGoal(message)) setLive((current) => new Map(current).set(message.id, message));
    },
    onMissedFrames() {
      setHistory(emptyHistory);
      setLive(new Map());
      setReadGeneration((generation) => generation + 1);
    },
  }), [threadId]);

  useEffect(() => {
    if (!readPage) return;
    const controller = new AbortController();
    const query = new URLSearchParams(open ? undefined : { limit: "1" });
    if (before !== undefined && before !== null) query.set("before", before);
    const path = `/api/threads/${encodeURIComponent(threadId)}/goals${query.size ? `?${query}` : ""}`;
    void api<GoalPage>(path, { signal: controller.signal, background: !open }).then((page) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(page.messages) || (page.nextBefore !== null && (!page.nextBefore || page.nextBefore === before))) {
        throw new Error("Invalid goal history page");
      }
      setHistory((current) => ({ goals: [...current.goals, ...page.messages.filter(isGoal)], before: page.nextBefore }));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setHistory({ goals: [], failed: true });
        setLive(new Map());
      } else {
        setHistory((current) => ({ ...current, failed: true }));
      }
    });
    return () => controller.abort();
  }, [before, open, readGeneration, readPage, threadId]);

  const goals = useMemo(() => {
    const byId = new Map<string, GoalMessage>();
    for (const message of held.toReversed()) byId.set(message.id, live.get(message.id) ?? message);
    if (hasMore) {
      for (const message of history.goals) if (!byId.has(message.id)) byId.set(message.id, live.get(message.id) ?? message);
      for (const message of live.values()) if (!byId.has(message.id)) byId.set(message.id, message);
    }
    return [...byId.values()].sort((a, b) => {
      const started = (b.goalRun?.startedAt ?? b.at) - (a.goalRun?.startedAt ?? a.at);
      return started || b.at - a.at || Number(a.id < b.id) - Number(a.id > b.id);
    });
  }, [hasMore, held, history.goals, live]);
  return { goals, loading: readPage, failed: Boolean(hasMore && failed), retry: () => setHistory((current) => ({ ...current, failed: false })) };
}

export function ThreadGoals({ thread, botId, canSwitchVersion, inForkPanel }: {
  thread: Thread;
  botId?: string;
  canSwitchVersion?: boolean;
  inForkPanel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { goals, loading, failed, retry } = useGoalHistory(thread, open);
  const { threadId } = thread;
  const store = useStoreRef();
  const viewer = useViewerEmail();
  useActiveLocale();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = goals[0];
  const storageKey = viewer === undefined ? null : `omb.dismissedGoals:${JSON.stringify([viewer, threadId])}`;
  const [dismissals, setDismissals] = useState<{ key: string; ids: ReadonlySet<string> }>();
  const saved = useMemo(() => storageKey === null ? noDismissals : readDismissals(storageKey), [storageKey]);
  const dismissedIds = dismissals?.key === storageKey ? dismissals.ids : saved;
  const isDismissed = (message: GoalMessage) => dismissedIds.has(message.id) && isInactiveGoal(message);
  const shownGoals = goals.filter((message) => !isDismissed(message));
  const pinned = latest && !isDismissed(latest) ? latest : undefined;
  const rememberDismissals = (ids: ReadonlySet<string>) => {
    if (storageKey === null) return;
    setDismissals({ key: storageKey, ids });
    try {
      if (ids.size) localStorage.setItem(storageKey, JSON.stringify([...ids]));
      else localStorage.removeItem(storageKey);
    } catch {}
  };
  const dismiss = storageKey === null ? undefined : (message: GoalMessage) => {
    if (isInactiveGoal(message)) rememberDismissals(new Set(dismissedIds).add(message.id));
  };
  const restore = shownGoals.length < goals.length ? () => rememberDismissals(noDismissals) : undefined;

  const jump = async (message: GoalMessage, signal: AbortSignal): Promise<boolean> => {
    const currentThread = () => {
      const state = store.state();
      return inForkPanel
        ? state.forkPanel?.threadId === threadId ? state.forkPanel : undefined
        : (botId ? state.bots : state.groups).find((owner) => owner.threadId === threadId);
    };
    const current = currentThread();
    if (!current) throw new Error(t("chat.conversationGone"));
    const generation = store.state().transcriptGeneration[threadId] ?? 0;
    await loadThroughMessage(current, message.id, generation, store.dispatch, signal);
    signal.throwIfAborted();
    let loaded = currentThread();
    if (loaded && "hasMore" in loaded && loaded.hasMore && loaded.messages[0]?.id !== current.messages[0]?.id && !loaded.messages.some((row) => row.id === message.id)) {
      await loadThroughMessage(loaded, message.id, store.state().transcriptGeneration[threadId] ?? 0, store.dispatch, signal);
      signal.throwIfAborted();
      loaded = currentThread();
    }
    if (!loaded?.messages.some((row) => row.id === message.id)) throw new Error(t("chat.goals.jumpFailed"));
    if (botId && "activeLeafId" in loaded && !visibleMessages(loaded).some((row) => row.id === message.id)) {
      if (!canSwitchVersion || ("yourAccess" in loaded && loaded.yourAccess === "view")) return false;
      const result = await api<{ activeLeafId: string }>(`/api/bots/${encodeURIComponent(botId)}/active-branch`, {
        method: "POST",
        body: JSON.stringify({ messageId: message.id, threadId }),
        signal,
      });
      signal.throwIfAborted();
      store.dispatch({ type: inForkPanel ? "forkPanelActive" : "threadActive", threadId, activeLeafId: result.activeLeafId });
    }
    store.dispatch({ type: "focusMessage", threadId, messageId: message.id });
    return true;
  };

  if (!latest && !failed && !open) return null;
  return (
    <div className="px-4 pb-2">
      <section aria-label={t("chat.goals.title")} className={cn("chat-column flex min-w-0 items-center gap-2", pinned && "rounded-xl border border-hairline bg-card px-3 py-1")}>
        {pinned?.goalRun ? <PinnedGoalSummary run={pinned.goalRun} /> : pinned && (
          <h2 dir="auto" title={pinned.text} className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{goalTitle(pinned)}</h2>
        )}
        <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} className="ui-button ui-button-sm shrink-0" onClick={() => setOpen(true)}>{t("chat.goals.title")}</button>
        {pinned && dismiss && isInactiveGoal(pinned) && (
          <button type="button" className="ui-icon-button shrink-0" aria-label={t("chat.goals.dismiss")} title={t("chat.goals.dismiss")} onClick={() => { dismiss(pinned); trigger.current?.focus(); }}><X size={16} aria-hidden="true" /></button>
        )}
      </section>
      {open && <GoalsPanel id={panelId} goals={shownGoals} loading={loading} failed={failed} retry={retry} dismiss={dismiss} restore={restore} onClose={() => setOpen(false)} onJump={jump} solo={Boolean(botId)} />}
    </div>
  );
}

function GoalsPanel({ id, goals, loading, failed, retry, dismiss, restore, onClose, onJump, solo }: {
  id: string;
  goals: GoalMessage[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
  dismiss?: (message: GoalMessage) => void;
  restore?: () => void;
  onClose: () => void;
  onJump: (message: GoalMessage, signal: AbortSignal) => Promise<boolean>;
  solo: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const [jumping, setJumping] = useState(false);
  const [jumpFailed, setJumpFailed] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const preview = goals.find((message) => message.id === previewId);
  const close = () => {
    request.current?.abort();
    onClose();
  };
  useModalDialog(dialog, close);
  useEffect(() => () => request.current?.abort(), []);
  const locale = intlLocale();
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  const jump = async (message: GoalMessage) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    dialog.current?.focus();
    setJumping(true);
    setJumpFailed(false);
    setPreviewId(undefined);
    try {
      if (await onJump(message, controller.signal)) close();
      else if (!controller.signal.aborted) setPreviewId(message.id);
    } catch {
      if (!controller.signal.aborted) setJumpFailed(true);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setJumping(false);
    }
  };

  return createPortal(
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} id={id} tabIndex={-1} className="ui-modal flex max-h-[min(40rem,calc(100dvh-2rem))] w-full max-w-lg flex-col text-ink">
        <header className="flex items-center justify-between gap-2 px-4 py-3">
          <h2 id={`${id}-title`} className="text-[17px] font-semibold">{t("chat.goals.title")}</h2>
          <button type="button" className="ui-icon-button shrink-0" aria-label={t("common.close")} onClick={close}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-4">
          {restore && <button type="button" className="ui-button ui-button-sm mb-2" onClick={() => { restore(); dialog.current?.focus({ preventScroll: true }); }}>{t("chat.goals.restoreDismissed")}</button>}
          {jumping && <p role="status" className="mb-2 text-[13px] text-ink-secondary">{t("chat.goals.opening")}</p>}
          {jumpFailed && <p role="alert" className="mb-2 text-[13px] text-danger">{t("chat.goals.jumpFailed")}</p>}
          {preview && <div className="mb-3 space-y-2">
            <p role="status" className="text-[13px] text-ink-secondary">{t("chat.goals.otherVersion")}</p>
            <GoalRunCard message={preview} solo={solo} />
          </div>}
          <ol className="divide-y divide-hairline" aria-busy={loading || undefined}>
            {goals.map((message) => {
              const run = message.goalRun;
              const title = goalTitle(message);
              return <li key={message.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <h3 dir="auto" title={title} className="truncate text-[13px] font-medium">{title}</h3>
                  {run && <>
                    <p className="text-[12px] tabular-nums text-ink-secondary">{goalRunStatus(run)} · {goalRunTurnCount(run)}</p>
                    <p className="text-[12px] text-ink-secondary">{t("chat.goals.started", { time: time.format(run.startedAt) })}</p>
                    {run.finishedAt !== undefined && <p className="text-[12px] text-ink-secondary">{t("chat.goals.ended", { time: time.format(run.finishedAt) })}</p>}
                  </>}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className="ui-button ui-button-sm" disabled={jumping} aria-label={t("chat.goals.jumpTo", { goal: title })} onClick={() => void jump(message)}>{t("chat.goals.jump")}</button>
                  {dismiss && isInactiveGoal(message) && (
                    <button type="button" className="ui-icon-button shrink-0" disabled={jumping} aria-label={t("chat.goals.dismissGoal", { goal: title })} title={t("chat.goals.dismiss")} onClick={() => { dismiss(message); dialog.current?.focus({ preventScroll: true }); }}><X size={16} aria-hidden="true" /></button>
                  )}
                </div>
              </li>;
            })}
          </ol>
          {loading && <p role="status" className="py-2 text-[13px] text-ink-secondary">{t("chat.goals.loading")}</p>}
          {failed && <div className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
            <p role="alert" className="text-ink-secondary">{t("chat.goals.loadFailed")}</p>
            <button type="button" className="ui-button ui-button-sm" onClick={retry}>{t("common.tryAgain")}</button>
          </div>}
          {!loading && !failed && !goals.length && <p className="py-2 text-[13px] text-ink-secondary">{t(restore ? "chat.goals.allDismissed" : "chat.goals.empty")}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
