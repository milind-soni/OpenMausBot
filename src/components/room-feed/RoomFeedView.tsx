import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import { catchUpOldMarks, openFeedThread } from "@/lib/room-feed";
import { simpleRoomHeader } from "@/lib/room-panel";
import { roomThreadAttention, roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { foldClosedRuns, threadRowCloser, unfoldStep } from "@/lib/room-thread-close";
import { useComposerDockPad } from "@/lib/composer-dock";
import { sameDrawnBots } from "@/lib/drawn-bots";
import type { Bot, Group } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { ChatErrorBanner, ChatNotice } from "../ChatErrorBanner";
import { ChatBackdrop, GlassBar, GlassScrollFrame } from "../GlassScrollFrame";
import { ManageMembersPanel } from "../ManageMembersPanel";
import { RoomBulletin } from "../RoomBulletin";
import { RoomChiefAbsent } from "../RoomChiefAbsent";
import { RoomHeader } from "../RoomHeader";
import { RoomHoldsBanner } from "../RoomHoldsBanner";
import { RoomWorkingFolder } from "../RoomWorkingFolder";
import { roomThreadRowActions } from "../SidebarGroupThreadList";
import { isArchived, useRelativeNow } from "../SidebarThreadRow";
import { JumpToLatestButton } from "../JumpToLatestButton";
import { FeedComposer } from "./FeedComposer";
import { useHiddenMark } from "./unread-offscreen";
import { RoomFeedRow, type FeedRowActions, type FeedRowData } from "./RoomFeedRow";
import { useRoomThreads, type FeedThread } from "./use-room-threads";

/** How near the foot the feed counts as being read there, so a new thread keeps it at the foot. */
const FOOT_PX = 48;
/** Only the person scrolling takes the feed off its foot; a row opening beside it or a window resize never does. */
const INTENT_MS = 1_000;

function toRow(group: Group, { task, summary }: FeedThread, bots: readonly Bot[]): FeedRowData {
  const { waiting, unread } = roomThreadAttention(group, task, bots);
  return {
    threadId: task.threadId,
    speaker: summary.first.speaker,
    text: summary.first.text,
    clipped: summary.first.clipped,
    at: summary.first.at,
    replies: summary.replies,
    lastReplyAt: summary.lastReplyAt,
    repliers: summary.repliers,
    mark: waiting ? "waiting" : unread ? "unread" : null,
    working: roomThreadWorking(group, task.threadId),
    workingBotId: roomThreadSpeakerId(group, task.threadId),
    title: task.title,
    pinned: task.pinned === true,
    archived: isArchived(task),
    closedBy: threadRowCloser(task),
  };
}

/** A closed thread folds away once nothing in it waits to be seen: not unread, not waiting, not running, not pinned and
 * not the one open beside the feed. */
const folds = (row: FeedRowData, openThread: string | null) =>
  Boolean(row.closedBy) && row.mark === null && !row.working && !row.pinned && row.threadId !== openThread;

/** A room as one feed of its threads, oldest at the top and the newest just above the composer, where a line starts a
 * new thread. A row opens its thread beside the feed; the room's current thread, which is everyone's, never moves. */
export function RoomFeedView({ group }: { group: Group }) {
  const dispatch = useStoreDispatch();
  const store = useStoreRef();
  const bots = useStoreSelector((state) => state.bots, sameDrawnBots);
  const you = useStoreSelector((state) => state.config?.profile?.name?.trim()) || t("room.feed.you");
  const error = useStoreSelector((state) => state.error);
  const notice = useStoreSelector((state) => state.notice);
  const openThread = useStoreSelector((state) => (state.forkPanel?.kind === "group" && state.forkPanel.ownerId === group.id ? state.forkPanel.threadId : null));
  const advanced = useAdvancedMode();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const simpleHeader = simpleRoomHeader({ advanced, remoteClient, group });
  const members = useMemo(() => group.memberIds.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)), [group.memberIds, bots]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const now = useRelativeNow();
  const hasArchived = (group.tasks ?? []).some(isArchived);
  const deletable = (group.tasks?.length ?? 1) > 1;
  const [showArchived, setShowArchived] = useState(false);
  const { threads, failed, retry } = useRoomThreads(group, showArchived && hasArchived);
  const actions = useMemo<FeedRowActions>(() => {
    const room = roomThreadRowActions(group.id, dispatch);
    const leave = (threadId: string) => { if (store.state().forkPanel?.threadId === threadId) dispatch({ type: "closeForkPanel" }); };
    return {
      ...room,
      onDelete: (task) => { leave(task.threadId); room.onDelete(task); },
      onArchive: (task, archivedAt) => { if (archivedAt !== null) leave(task.threadId); room.onArchive(task, archivedAt); },
      deletable,
    };
  }, [group.id, dispatch, store, deletable]);
  // Unread marks older than the feed are read once, the first time the room shows as its feed on this device.
  const since = useStoreSelector((state) => state.config?.features?.roomFeedSince);
  useEffect(() => {
    void catchUpOldMarks(store.state().groups.find((candidate) => candidate.id === group.id) ?? group, since,
      (patched) => dispatch({ type: "groupPatched", group: patched }));
    // Once per room shown, not on every change of its threads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, since]);
  const [pending, setPending] = useState<{ text: string; at: number; threadId: string | null } | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(() => {
    if (!threads) return null;
    const listed = threads.map((thread) => toRow(group, thread, bots));
    if (!pending || (pending.threadId && listed.some((row) => row.threadId === pending.threadId))) return listed;
    return [...listed, { threadId: pending.threadId ?? "", speaker: { person: {} }, text: pending.text, at: pending.at, replies: 0, lastReplyAt: null,
      repliers: [], mark: null, working: false, workingBotId: null } satisfies FeedRowData];
  }, [threads, pending, group, bots]);
  const items = useMemo(() => rows && foldClosedRuns(rows, (row) => folds(row, openThread), unfolded), [rows, openThread, unfolded]);
  const unfold = useCallback((threadIds: readonly string[]) => {
    // The fold stays where the person pressed it, and what it shows opens under it.
    atFoot.current = false;
    setUnfolded((shown) => new Set([...shown, ...unfoldStep({ threadIds })]));
  }, []);

  const waiting = useCallback((text: string | null) => {
    setPending(text === null ? null : { text, at: Date.now(), threadId: null });
    atFoot.current = true;
  }, []);
  const started = useCallback((threadId: string) => setPending((current) => current && { ...current, threadId }), []);
  const open = useCallback((threadId: string) => { if (threadId) dispatch(openFeedThread(group.id, threadId, true)); }, [dispatch, group.id]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atFoot = useRef(true);
  const scrolledAt = useRef(0);
  const moved = useCallback(() => { scrolledAt.current = Date.now(); }, []);
  const hidden = useHiddenMark(scrollRef, { changed: rows, bottomInset: composerDock.height, beforeJump: moved });
  useLayoutEffect(() => {
    const scroller = scrollRef.current, content = contentRef.current;
    if (!scroller || !content) return;
    const keep = () => { if (atFoot.current) scroller.scrollTop = scroller.scrollHeight; };
    keep();
    const sizes = new ResizeObserver(keep);
    sizes.observe(content);
    sizes.observe(scroller);
    return () => sizes.disconnect();
  }, [group.id]);

  return (
    <main data-look="chat" data-room-feed={group.id} data-feed-area="" className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <ChatBackdrop />
      {membersOpen && !remoteClient && <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
        <GlassBar edge="top" fade={!advanced && !remoteClient} className="z-[25]">
          <RoomHeader group={group} members={members} simple={simpleHeader} remoteClient={remoteClient} feed
            findOpen={false} onToggleFind={() => {}} onToggleFolder={() => setFolderOpen((shown) => !shown)} onOpenMembers={() => setMembersOpen(true)}
            membersTriggerRef={membersTriggerRef} />
          <ChatErrorBanner message={error} onDismiss={() => dispatch({ type: "error", message: null })} />
          <ChatNotice notice={notice} />
          {!remoteClient && !simpleHeader && <RoomChiefAbsent group={group} />}
          <RoomHoldsBanner group={group} members={members} />
          {!simpleHeader && <RoomBulletin group={group} remoteClient={remoteClient} />}
          {folderOpen && <div className="w-full px-5"><div className="mb-1"><RoomWorkingFolder group={group} /></div></div>}
        </GlassBar>
        <div ref={scrollRef} data-feed-fade="" className="glass-scroller h-full overflow-x-hidden overflow-y-auto px-4 [overflow-anchor:none]"
          onWheel={moved} onTouchMove={moved} onKeyDown={moved} onPointerDown={moved}
          onScroll={(event) => {
            const el = event.currentTarget, foot = el.scrollHeight - el.scrollTop - el.clientHeight < FOOT_PX;
            if (foot || Date.now() - scrolledAt.current < INTENT_MS) atFoot.current = foot;
            hidden.measure();
          }}>
          <div ref={contentRef} className="glass-scroller-content chat-column flex min-h-full w-full flex-col justify-end" style={{ paddingBottom: composerDock.pad }}>
            {hasArchived && rows !== null && <button type="button" data-feed-archived-toggle="" aria-pressed={showArchived} onClick={() => setShowArchived((shown) => !shown)}
              className="mt-2 inline-flex h-7 items-center self-center rounded-md px-2 text-[13px] font-medium leading-4 text-ink-secondary hover:text-ink">
              {showArchived ? t("room.feed.hideArchived") : t("room.feed.showArchived")}
            </button>}
            {rows === null || items === null ? (
              failed && (
                <p role="alert" className="flex items-center justify-center gap-2 py-6 text-[13px] text-ink-secondary">
                  {t("room.feed.loadFailed")}
                  <button type="button" className="ui-button ui-button-sm" onClick={retry}>{t("chat.retry")}</button>
                </p>
              )
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-ink-secondary">{t("room.feed.empty")}</p>
            ) : (
              <ol aria-label={t("room.feed.aria", { name: group.name })} className="flex flex-col gap-0.5 py-2">
                {items.map((item) => item.kind === "fold" ? (
                  <li key={`fold:${item.key}`} className="flex">
                    <button type="button" data-feed-fold={item.key} onClick={() => unfold(item.threadIds)}
                      className="ms-12 flex h-8 touch:h-10 items-center rounded-md px-2 text-[13px] font-medium leading-[18px] text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08] motion-reduce:transition-none">
                      {item.threadIds.length === 1 ? t("room.feed.closedOne") : t("room.feed.closedMany", { count: item.threadIds.length })}
                    </button>
                  </li>
                ) : (
                  <RoomFeedRow key={item.row.threadId || "pending"} row={item.row} groupId={group.id} bots={bots} you={you} now={now} open={item.row.threadId !== "" && item.row.threadId === openThread}
                    onOpen={open} actions={actions} />
                ))}
              </ol>
            )}
          </div>
        </div>
        {hidden.dir && <JumpToLatestButton up={hidden.dir === "above"} label={t(hidden.dir === "above" ? "room.feed.unreadAbove" : "room.feed.unreadBelow")}
          onClick={hidden.jump} style={{ bottom: composerDock.height }} />}
        <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2] chat-column-dock">
          <FeedComposer group={group} members={members} onPending={waiting} onStarted={started} />
        </div>
      </GlassScrollFrame>
    </main>
  );
}
