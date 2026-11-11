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
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
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
import { useStore } from "@/state/store";

export const AUTO_EXPAND_TOP_THRESHOLD = 250;

const WIDGETS_WITH_OWN_ARROW_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"], [role="radiogroup"], [role="slider"], select, [contenteditable="true"]';

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

  // Follow breaks only on an upward user gesture: content growth flickers "at bottom" false for a frame.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const transcriptKey = `${ownerId}:${threadId}`;
  const tailStart = tailWindowStart(messages.length);
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailStart,
    end: null,
  }));
  const switched = transcriptWindow.key !== transcriptKey;
  const nextStart = switched
    ? tailStart
    : follow && transcriptWindow.end === null
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

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);
  useBottomFollowResize(scrollRef, transcriptRef, followRef, transcriptShown ? transcriptKey : null);

  useEffect(() => setBottomFollow(true), [transcriptKey, setBottomFollow]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [threadId, messages, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(threadId, messages.length > 0, scrollRef);

  // `follow` is omitted on purpose: re-arming only arms future content and never scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
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
    previousScrollTop.current = el.scrollTop;
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
  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
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
      } else if (atEnd()) {
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
      } else if (atEnd()) {
        setBottomFollow(true);
      }
    },
    onScroll: () => {
      const el = scrollRef.current;
      if (!el) return;
      const scrollTop = el.scrollTop;
      const resume = shouldResumeBottomFollow({
        following: followRef.current,
        previousScrollTop: previousScrollTop.current,
        scrollTop,
        distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
      });
      previousScrollTop.current = scrollTop;
      if (resume) {
        setBottomFollow(true);
      } else if (!followRef.current && scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) {
        triggerAutoEarlier();
      }
    },
  };

  return {
    scrollRef,
    transcriptRef,
    topSentinelRef,
    transcriptKey,
    following: follow,
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
