import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { BOTTOM_FOLLOW_THRESHOLD, followBottomGrowth, useBottomFollowResize } from "@/lib/bottom-follow";
import { useFocusMessage } from "@/lib/focus-message";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  followWindowStart,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { reducedMotion } from "@/lib/onboarding";
import {
  JUMP_TO_LATEST_DELAY_MS,
  initialTranscriptFollow,
  readTranscriptPosition,
  rememberTranscriptPosition,
  rowScrollTop,
  settleScroll,
  topRow,
  transitionTranscriptFollow,
  wantsJumpToLatest,
  type TranscriptFollow,
  type TranscriptFollowEvent,
} from "@/lib/transcript-follow";
import { hasLiveReply } from "@/state/live-reply";
import { useStore } from "@/state/store";

export const AUTO_EXPAND_TOP_THRESHOLD = 250;

const WIDGETS_WITH_OWN_ARROW_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"], [role="radiogroup"], [role="slider"], select, [contenteditable="true"]';

const atEndOf = (el: HTMLElement | null) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;

interface TranscriptVisit {
  key: string;
  follow: TranscriptFollow;
  /** The row to put back at the top, and the window start that draws it; absent when the visit opens at the end. */
  restore?: { rowId: string; offsetWithinRow: number; start: number };
}

function openVisit(key: string, messages: readonly { id: string }[]): TranscriptVisit {
  const remembered = readTranscriptPosition(key);
  const rowIndex = remembered && !remembered.atEnd && remembered.rowId ? messages.findIndex((message) => message.id === remembered.rowId) : -1;
  if (!remembered || rowIndex < 0) return { key, follow: initialTranscriptFollow(true) };
  const start = Math.min(rowIndex, Math.max(0, Math.min(remembered.windowStart ?? rowIndex, tailWindowStart(messages.length))));
  return { key, follow: initialTranscriptFollow(false), restore: { rowId: remembered.rowId!, offsetWithinRow: remembered.offsetWithinRow ?? 0, start } };
}

export function useTranscriptViewport<T extends { id: string; role?: string }>({
  ownerId,
  threadId,
  messages,
  pinOn,
  transcriptShown = true,
  hasMore = false,
}: {
  ownerId: string;
  threadId: string;
  messages: readonly T[];
  pinOn: DependencyList;
  transcriptShown?: boolean;
  hasMore?: boolean;
}) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const touchY = useRef(0);

  const transcriptKey = `${ownerId}:${threadId}`;
  const tailStart = tailWindowStart(messages.length);
  // One visit per conversation: switching back opens where the reader left it, or at the end if they were there.
  const [visit, setVisit] = useState(() => openVisit(transcriptKey, messages));
  const [transcriptWindow, setTranscriptWindow] = useState<{ key: string; start: number; end: number | null }>(
    () => ({ key: transcriptKey, start: visit.restore?.start ?? tailStart, end: null }),
  );
  const followNow = useRef<{ key: string; follow: TranscriptFollow }>({ key: visit.key, follow: visit.follow });
  const followRef = useRef(visit.follow.mode === "following");
  const switched = transcriptWindow.key !== transcriptKey;
  const current = visit.key === transcriptKey ? visit : openVisit(transcriptKey, messages);
  if (current !== visit) setVisit(current);
  if (followNow.current.key !== transcriptKey) {
    followNow.current = { key: transcriptKey, follow: current.follow };
    followRef.current = current.follow.mode === "following";
  }
  const follow = followNow.current.follow;
  const following = follow.mode === "following";
  const nextStart = switched
    ? current.restore?.start ?? tailStart
    : following && transcriptWindow.end === null
      ? followWindowStart(messages, transcriptWindow.start)
      : transcriptWindow.start;
  if (switched || nextStart !== transcriptWindow.start) {
    setTranscriptWindow({ key: transcriptKey, start: nextStart, end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );
  const windowRef = useRef(transcriptWindow);
  windowRef.current = transcriptWindow;

  const [, setFollowShown] = useState(follow);
  const navigationCount = useRef(0);
  // A reply streaming in is followed smoothly; anything else (a switch, history loading, a sent message) lands at once.
  const smoothFollow = useCallback(() => hasLiveReply(threadId) && !reducedMotion(), [threadId]);
  const followEvent = useCallback((event: TranscriptFollowEvent) => {
    const before = followNow.current.follow;
    const after = transitionTranscriptFollow(before, event);
    if (event.type === "navigated") navigationCount.current += 1;
    if (after === before) return;
    followNow.current = { key: followNow.current.key, follow: after };
    followRef.current = after.mode === "following";
    const el = scrollRef.current;
    if (el && before.mode === "following" && after.mode === "released" && smoothFollow()) {
      // A smooth follow scroll keeps running after the reader takes over; an instant scroll to where it is halts it.
      el.scrollTo({ top: el.scrollTop });
    }
    if (after.mode === "following") rememberTranscriptPosition(followNow.current.key, { atEnd: true });
    setFollowShown(after);
  }, [smoothFollow]);
  const setBottomFollow = useCallback((next: boolean) => followEvent({ type: next ? "followEnd" : "navigated" }), [followEvent]);

  const nearEnd = () => atEndOf(scrollRef.current);
  const noteEnd = useCallback(() => {
    if (scrollRef.current) followEvent({ type: atEndOf(scrollRef.current) ? "reachedEnd" : "leftEnd" });
  }, [followEvent]);

  const recordFrame = useRef(false);
  const recordPosition = () => {
    if (recordFrame.current) return;
    recordFrame.current = true;
    requestAnimationFrame(() => {
      recordFrame.current = false;
      const el = scrollRef.current, list = transcriptRef.current, key = followNow.current.key;
      if (!el || !list || key !== windowRef.current.key) return;
      if (followRef.current || nearEnd()) return rememberTranscriptPosition(key, { atEnd: true });
      const top = topRow(el, list);
      if (top) rememberTranscriptPosition(key, { atEnd: false, ...top, windowStart: windowRef.current.start, windowEnd: windowRef.current.end });
    });
  };

  // Content growing under a released reader can only take the end away from them; their own scroll brings it back.
  const noteLeftEnd = useCallback(() => {
    if (!atEndOf(scrollRef.current)) followEvent({ type: "leftEnd" });
  }, [followEvent]);
  const onTranscriptResize = useCallback(() => {
    const el = scrollRef.current;
    if (el && !followBottomGrowth(el, followRef.current, smoothFollow())) noteLeftEnd();
  }, [noteLeftEnd, smoothFollow]);
  useBottomFollowResize(scrollRef, transcriptRef, transcriptShown ? transcriptKey : null, onTranscriptResize);

  // The person sent a message: whatever they were reading, the conversation follows its end again.
  const newestId = messages.at(-1)?.id;
  const sentLast = Boolean(newestId?.startsWith("optimistic-"));
  useLayoutEffect(() => {
    if (sentLast) setBottomFollow(true);
  }, [newestId, sentLast, setBottomFollow]);

  // A remembered row is put back before the first paint and held while late layout settles; any move of the reader's
  // own stops that.
  useLayoutEffect(() => {
    const el = scrollRef.current, list = transcriptRef.current, restore = current.restore;
    if (!el || !list || !restore) return;
    const navigations = navigationCount.current;
    const target = () => rowScrollTop(el, list, restore.rowId, restore.offsetWithinRow);
    const first = target();
    if (first === undefined) return;
    el.scrollTop = first;
    settleScroll(el, target, () => navigationCount.current !== navigations || followNow.current.key !== current.key);
  }, [current]);

  const appliedFocus = useRef<number | null>(null);
  // Before the follow scroll below: a search jump into the conversation just opened wins over its end.
  useLayoutEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    followEvent({ type: "navigated" });
    followEvent({ type: "leftEnd" });
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [threadId, messages, followEvent, state.focusMessage, transcriptKey]);
  useFocusMessage(threadId, messages.length > 0);

  // Before paint, so a conversation opens at its end with no frame elsewhere. `follow` is omitted on purpose: re-arming
  // only arms future content and never scrolls.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!followRef.current) return noteLeftEnd();
    el.scrollTo({ top: el.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinOn is the caller's dependency list
  }, [transcriptKey, messages.length, ...pinOn]);

  // Shift scrollTop by the growth after commit (scroll anchoring is off here); a switch drops the capture.
  const preExpandHeight = useRef<{ key: string; height: number } | null>(null);
  const expandingRef = useRef(false);

  const holdRowForPrepend = () => {
    preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
    setBottomFollow(false);
  };
  const oldestId = messages[0]?.id;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) {
      expandingRef.current = false;
      return;
    }
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) {
      expandingRef.current = false;
      return;
    }
    el.scrollTop += el.scrollHeight - captured.height;
    expandingRef.current = false;
  }, [transcriptWindow.start, oldestId, transcriptKey]);

  const showEarlier = () => {
    holdRowForPrepend();
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };
  const olderPending = Boolean(state.loadingOlder[threadId]);
  const loadOlder = () => {
    holdRowForPrepend();
    dispatch({ type: "loadOlderMessages", threadId });
  };

  useEffect(() => {
    if (!olderPending) expandingRef.current = false;
  }, [olderPending]);

  const triggerAutoEarlier = useCallback(() => {
    if (expandingRef.current) return;
    if (hiddenCount > 0) {
      expandingRef.current = true;
      holdRowForPrepend();
      const start = expandWindowStart(startIndex);
      setTranscriptWindow((w) => ({ ...w, start }));
    } else if (hasMore && !olderPending) {
      expandingRef.current = true;
      holdRowForPrepend();
      dispatch({ type: "loadOlderMessages", threadId });
    }
  }, [hiddenCount, startIndex, hasMore, olderPending, threadId, dispatch, transcriptKey]);

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !followRef.current) {
          triggerAutoEarlier();
        }
      },
      { root, rootMargin: "250px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [triggerAutoEarlier]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      const ownKeys = typeof (e.target as Element | null)?.closest === "function" &&
        Boolean((e.target as Element).closest(WIDGETS_WITH_OWN_ARROW_KEYS));
      if (ownKeys || !canScroll()) return;
      if (e.key === "PageUp" || ((e.key === "Home" || e.key === "ArrowUp") && !typing)) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const canScroll = () => {
    const el = scrollRef.current;
    return Boolean(el && el.scrollHeight - el.clientHeight >= 1);
  };
  // Rows that draw nothing (hidden tool steps) can leave a window too short to scroll while earlier ones exist.
  const canScrollUp = () => canScroll() || hiddenCount > 0 || Boolean(hasMore);
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailStart, end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    });
  };

  const scrollHandlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      // Grabbing the scrollbar is a scroll gesture: its lane lies past clientWidth.
      const el = scrollRef.current;
      if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
    },
    onWheel: (e: WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < 0 && canScrollUp()) {
        setBottomFollow(false);
        const el = scrollRef.current;
        if (el && el.scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) {
          triggerAutoEarlier();
        }
      } else if (nearEnd()) {
        setBottomFollow(true);
      }
    },
    onTouchStart: (e: TouchEvent<HTMLDivElement>) => {
      touchY.current = e.touches[0]?.clientY ?? 0;
    },
    onTouchMove: (e: TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY.current + 4 && canScrollUp()) {
        setBottomFollow(false);
        const el = scrollRef.current;
        if (el && el.scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) {
          triggerAutoEarlier();
        }
      } else if (nearEnd()) {
        setBottomFollow(true);
      }
    },
    onScroll: () => {
      const el = scrollRef.current;
      if (!el) return;
      noteEnd();
      recordPosition();
      if (!followRef.current && el.scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) triggerAutoEarlier();
    },
  };

  const wantsJump = wantsJumpToLatest(follow);
  const [jumpShown, setJumpShown] = useState(false);
  useEffect(() => {
    if (!wantsJump) return setJumpShown(false);
    const timer = setTimeout(() => setJumpShown(true), JUMP_TO_LATEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [wantsJump, transcriptKey]);

  return {
    scrollRef,
    transcriptRef,
    topSentinelRef,
    transcriptKey,
    following,
    /** The reader left the end a moment ago and has not come back: offer the way down. */
    showJumpToLatest: wantsJump && jumpShown,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    hasEarlier: hiddenCount > 0 || Boolean(hasMore),
    showEarlier,
    showLater,
    loadOlder,
    jumpToLatest,
    scrollHandlers,
  };
}
