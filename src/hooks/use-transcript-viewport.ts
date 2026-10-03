// The scrolling transcript of a 1:1 chat or a room: which rows mount, when
// the pane follows the bottom, and how it holds still while rows are
// prepended. ChatView and GroupView both use this one copy, so a viewport fix
// lands once.
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
import { useStore } from "@/state/store";

export function useTranscriptViewport<T extends { id: string; role?: string }>({
  ownerId,
  threadId,
  messages,
  pinOn,
  transcriptShown = true,
}: {
  /** The bot or room; opening another one re-arms bottom-follow. */
  ownerId: string;
  threadId: string;
  /** The full transcript. Only a window of it mounts. */
  messages: readonly T[];
  /** Besides a new row, what moves a following reader to the end: busy
   * flags, the composer's padding. Same length on every render. */
  pinOn: DependencyList;
  /** False while something else covers the transcript (a room's set-up form). */
  transcriptShown?: boolean;
}) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch/scrollbar/
  // keys), never on scroll position checks — content growth flickers "at
  // bottom" false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is per owner+thread; a render-phase
  // reset re-tails it on switch so the old thread's boundary never flashes
  // into the new one. While the reader follows the bottom, new rows slide the
  // boundary up so the window stays one window long, except that it stops at
  // the person's newest message while that message is mounted and at most one
  // more window back: the question stays on screen while a turn of hidden tool
  // steps answers it, and the window never passes two windows. A thread that
  // shrinks (a branch switch) re-tails it (followWindowStart). The boundary
  // holds still once they have scrolled away, so the rows they are reading
  // stay put.
  // Callers derive everything else (last reply, working dots) from the FULL
  // list.
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

  useEffect(() => setBottomFollow(true), [ownerId, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
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
  useFocusMessage(threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted: flipping it true used to yank the
  // viewport to the end. Re-pinning only arms future content; Jump to latest
  // and this effect on new rows do the scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinOn is the caller's dependency list
  }, [ownerId, messages.length, ...pinOn]);

  // Rows prepended at the front — Show earlier widening the local window, or
  // an older page arriving from the server — would push the row under the
  // reader down. Capture the height first, then after the commit shift
  // scrollTop by the growth so that row stays put (browser scroll anchoring
  // is disabled on this container). The capture belongs to the thread it was
  // taken in, and transcriptKey is a dependency so a switch drops a capture
  // from the thread being left instead of shifting the new one.
  const preExpandHeight = useRef<{ key: string; height: number } | null>(null);
  const holdRowForPrepend = () => {
    preExpandHeight.current = scrollRef.current ? { key: transcriptKey, height: scrollRef.current.scrollHeight } : null;
    // reading scrollback: a mid-expand stream event must not pin the bottom
    setBottomFollow(false);
  };
  const oldestId = messages[0]?.id;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) return;
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) return;
    el.scrollTop += el.scrollHeight - captured.height;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
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
  // Scrollback across the network: the snapshot holds a bounded page, and
  // everything before it is still on the server.
  const olderPending = Boolean(state.loadingOlder[threadId]);
  const loadOlder = () => {
    holdRowForPrepend();
    dispatch({ type: "loadOlderMessages", threadId });
  };

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home/ArrowUp
  // break follow like an upward wheel; the at-end onScroll check re-arms it.
  // ArrowUp only counts outside inputs — in the composer it edits, not scrolls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (e.key === "PageUp" || ((e.key === "Home" || e.key === "ArrowUp") && !typing)) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailStart, end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  // For the scrolling element, next to ref={scrollRef}.
  const scrollHandlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      // grabbing the scrollbar is a scroll gesture too — the lane lives
      // past the content box (clientWidth excludes it)
      const el = scrollRef.current;
      if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
    },
    onWheel: (e: WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < 0) setBottomFollow(false);
      else if (atEnd()) setBottomFollow(true);
    },
    onTouchStart: (e: TouchEvent<HTMLDivElement>) => {
      touchY.current = e.touches[0]?.clientY ?? 0;
    },
    onTouchMove: (e: TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY.current + 4) setBottomFollow(false);
      else if (atEnd()) setBottomFollow(true);
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
      if (resume) setBottomFollow(true);
    },
  };

  return {
    scrollRef,
    transcriptRef,
    transcriptKey,
    following: follow,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showEarlier,
    showLater,
    loadOlder,
    jumpToLatest,
    scrollHandlers,
  };
}
