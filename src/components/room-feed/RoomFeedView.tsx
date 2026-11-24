import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import { openFeedThread } from "@/lib/room-feed";
import { simpleRoomHeader } from "@/lib/room-panel";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { useComposerDockPad } from "@/lib/composer-dock";
import { sameDrawnBots } from "@/lib/drawn-bots";
import type { Bot, Group } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { ChatErrorBanner, ChatNotice } from "../ChatErrorBanner";
import { ChatBackdrop, GlassBar, GlassScrollFrame } from "../GlassScrollFrame";
import { ManageMembersPanel } from "../ManageMembersPanel";
import { RoomBulletin } from "../RoomBulletin";
import { RoomChiefAbsent } from "../RoomChiefAbsent";
import { RoomHeader } from "../RoomHeader";
import { RoomHoldsBanner } from "../RoomHoldsBanner";
import { RoomWorkingFolder } from "../RoomWorkingFolder";
import { useRelativeNow } from "../SidebarThreadRow";
import { FeedComposer } from "./FeedComposer";
import { RoomFeedRow, type FeedRowData } from "./RoomFeedRow";
import { useRoomThreads, type FeedThread } from "./use-room-threads";

/** How near the foot the feed counts as being read there, so a new thread keeps it at the foot. */
const FOOT_PX = 48;
/** Only the person scrolling takes the feed off its foot; a row opening beside it or a window resize never does. */
const INTENT_MS = 1_000;

const toRow = (group: Group, { task, summary }: FeedThread): FeedRowData => ({
  threadId: task.threadId,
  speaker: summary.first.speaker,
  text: summary.first.text,
  clipped: summary.first.clipped,
  at: summary.first.at,
  replies: summary.replies,
  lastReplyAt: summary.lastReplyAt,
  repliers: summary.repliers,
  mark: task.activity === "waiting-on-you" ? "waiting" : task.unread ? "unread" : null,
  working: roomThreadWorking(group, task.threadId),
  workingBotId: roomThreadSpeakerId(group, task.threadId),
});

/** A room as one feed of its threads, oldest at the top and the newest just above the composer, where a line starts a
 * new thread. A row opens its thread beside the feed; the room's current thread, which is everyone's, never moves. */
export function RoomFeedView({ group }: { group: Group }) {
  const dispatch = useStoreDispatch();
  const bots = useStoreSelector((state) => state.bots, sameDrawnBots);
  const you = useStoreSelector((state) => state.config?.profile?.name?.trim()) || t("room.feed.you");
  const error = useStoreSelector((state) => state.error);
  const notice = useStoreSelector((state) => state.notice);
  const openThread = useStoreSelector((state) => (state.forkPanel?.kind === "group" && state.forkPanel.ownerId === group.id ? state.forkPanel.threadId : null));
  const advanced = useAdvancedMode();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const simpleHeader = simpleRoomHeader({ advanced, remoteClient, group, setupPending: false });
  const members = useMemo(() => group.memberIds.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)), [group.memberIds, bots]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const now = useRelativeNow();
  const { threads, failed, retry } = useRoomThreads(group);
  const [pending, setPending] = useState<{ text: string; at: number; threadId: string | null } | null>(null);

  const rows = useMemo(() => {
    if (!threads) return null;
    const listed = threads.map((thread) => toRow(group, thread));
    if (!pending || (pending.threadId && listed.some((row) => row.threadId === pending.threadId))) return listed;
    return [...listed, { threadId: pending.threadId ?? "", speaker: { person: {} }, text: pending.text, at: pending.at, replies: 0, lastReplyAt: null,
      repliers: [], mark: null, working: false, workingBotId: null } satisfies FeedRowData];
  }, [threads, pending, group]);

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
    <main data-look="chat" data-room-feed={group.id} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <ChatBackdrop />
      {membersOpen && !remoteClient && <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
        <GlassBar edge="top" fade={!advanced && !remoteClient} className="z-[25]">
          <RoomHeader group={group} members={members} simple={simpleHeader} setupPending={false} remoteClient={remoteClient} feed
            findOpen={false} onToggleFind={() => {}} onToggleFolder={() => setFolderOpen((shown) => !shown)} onOpenMembers={() => setMembersOpen(true)}
            membersTriggerRef={membersTriggerRef} />
          <ChatErrorBanner message={error} onDismiss={() => dispatch({ type: "error", message: null })} />
          <ChatNotice notice={notice} />
          {!remoteClient && <RoomChiefAbsent group={group} />}
          <RoomHoldsBanner group={group} members={members} />
          {!simpleHeader && <RoomBulletin group={group} remoteClient={remoteClient} />}
          {folderOpen && <div className="w-full px-5"><div className="mb-1"><RoomWorkingFolder group={group} /></div></div>}
        </GlassBar>
        <div ref={scrollRef} className="glass-scroller h-full overflow-x-hidden overflow-y-auto px-4 [overflow-anchor:none]"
          onWheel={moved} onTouchMove={moved} onKeyDown={moved} onPointerDown={moved}
          onScroll={(event) => {
            const el = event.currentTarget, foot = el.scrollHeight - el.scrollTop - el.clientHeight < FOOT_PX;
            if (foot || Date.now() - scrolledAt.current < INTENT_MS) atFoot.current = foot;
          }}>
          <div ref={contentRef} className="glass-scroller-content chat-column flex min-h-full w-full flex-col justify-end" style={{ paddingBottom: composerDock.pad }}>
            {rows === null ? (
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
                {rows.map((row) => (
                  <RoomFeedRow key={row.threadId || "pending"} row={row} bots={bots} you={you} now={now} open={row.threadId !== "" && row.threadId === openThread} onOpen={open} />
                ))}
              </ol>
            )}
          </div>
        </div>
        <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2] chat-column-dock">
          <FeedComposer group={group} members={members} onPending={waiting} onStarted={started} />
        </div>
      </GlassScrollFrame>
    </main>
  );
}
