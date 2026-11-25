import {
  startTransition,
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
import { afterPaint } from "@/lib/after-paint";
import { useFocusMessage } from "@/lib/focus-message";
import {
  TRANSCRIPT_WINDOW_MAX,
  TRANSCRIPT_WINDOW_SIZE,
  capWindowEnd,
  firstFrameRow,
  focusWindowRange,
  followWindowStart,
  holdRows,
  resolveTranscriptWindow,
  restoreWindow,
  tailWindowStart,
  windowAfterPrepend,
  windowEarlier,
  windowLater,
  withRestingCard,
  type TranscriptWindowBounds,
} from "@/lib/transcript-window";
import { reducedMotion } from "@/lib/onboarding";
import { restoreSelection, selectedRows, setSelectionAside, type SetAsideSelection } from "@/lib/transcript-selection";
import {
  JUMP_TO_LATEST_DELAY_MS,
  initialTranscriptFollow,
  readTranscriptPosition,
  rememberTranscriptPosition,
  rowContentTop,
  rowScrollTop,
  rowsInView,
  settleScroll,
  topRow,
  transitionTranscriptFollow,
  wantsJumpToLatest,
  type TranscriptFollow,
  type TranscriptFollowEvent,
} from "@/lib/transcript-follow";
import { hasLiveReply } from "@/state/live-reply";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";

export const AUTO_EXPAND_TOP_THRESHOLD = 250;
/** How far from a window edge, in views, the next step is drawn: ahead of the reader, so it lands before they get there. */
const STEP_AHEAD_VIEWS = 1.5;
const stepAhead = (el: HTMLElement) => Math.max(AUTO_EXPAND_TOP_THRESHOLD, el.clientHeight * STEP_AHEAD_VIEWS);

const WIDGETS_WITH_OWN_ARROW_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"], [role="radiogroup"], [role="slider"], select, [contenteditable="true"]';

const gapBelow = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const atEndOf = (el: HTMLElement | null) => !el || gapBelow(el) < BOTTOM_FOLLOW_THRESHOLD;

interface TranscriptVisit {
  key: string;
  follow: TranscriptFollow;
  /** The row to put back at the top, and the window that draws it; absent when the visit opens at the end. */
  restore?: { rowId: string; offsetWithinRow: number } & TranscriptWindowBounds;
}

type HeldWindow = { key: string; first: string | undefined } & TranscriptWindowBounds;

function openVisit(key: string, messages: readonly { id: string }[]): TranscriptVisit {
  const remembered = readTranscriptPosition(key);
  const rowIndex = remembered && !remembered.atEnd && remembered.rowId ? messages.findIndex((message) => message.id === remembered.rowId) : -1;
  if (!remembered || rowIndex < 0) return { key, follow: initialTranscriptFollow(true) };
  const window = restoreWindow(messages.length, rowIndex, remembered.windowStart);
  return { key, follow: initialTranscriptFollow(false), restore: { rowId: remembered.rowId!, offsetWithinRow: remembered.offsetWithinRow ?? 0, ...window } };
}

/**
 * The window for this render: shifted over older rows put in front, tailed while following, capped while reading.
 * New rows past the cap wait below a reader up the page; under one reading near the bottom, the oldest rows go instead.
 */
function nextWindow(window: HeldWindow, messages: readonly { id: string; role?: string }[], following: boolean, readingBottom: () => boolean): TranscriptWindowBounds & { added: number } {
  const added = window.first !== undefined && window.first !== messages[0]?.id ? messages.findIndex((message) => message.id === window.first) : -1;
  const bounds = added > 0 ? windowAfterPrepend(window, added, messages.length) : { start: window.start, end: window.end };
  if (following) {
    const start = bounds.end === null ? followWindowStart(messages, bounds.start) : tailWindowStart(messages.length);
    return { start, end: null, added };
  }
  if (bounds.end !== null) return { ...bounds, added };
  const capped = capWindowEnd(bounds, messages.length);
  if (capped.end === null || !readingBottom()) return { ...capped, added };
  return { start: Math.max(bounds.start, messages.length - TRANSCRIPT_WINDOW_MAX), end: null, added };
}

export function useTranscriptViewport<T extends { id: string; role?: string }>({
  ownerId,
  threadId,
  messages,
  pinOn,
  transcriptShown = true,
  hasMore = false,
  rests,
}: {
  ownerId: string;
  threadId: string;
  messages: readonly T[];
  pinOn: DependencyList;
  transcriptShown?: boolean;
  hasMore?: boolean;
  /** A card work rests on until the person answers it; the newest one stays drawn when the window has left it behind. */
  rests?: (row: T) => boolean;
}) {
  const focusMessage = useStoreSelector((state) => state.focusMessage);
  const olderPending = useStoreSelector((state) => Boolean(state.loadingOlder[threadId]));
  const dispatch = useStoreDispatch();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const touchY = useRef(0);

  const transcriptKey = `${ownerId}:${threadId}`;
  const tailStart = tailWindowStart(messages.length);
  /**
   * The rows on screen before a window step, each with its top in the content; the commit after it moves the view by as
   * much as the first one still drawn moved, so a step drawn a few frames later keeps where the reader has scrolled since.
   */
  const anchor = useRef<{ key: string; rows: { rowId: string; contentTop: number }[]; height: number; from: TranscriptWindowBounds | null } | null>(null);
  const restingCardId = useRef<string | undefined>(undefined);
  /** `from`: the window a step drawn in a transition leaves; commits that still draw it are not the step's. */
  const holdRow = (from: TranscriptWindowBounds | null = null) => {
    const el = scrollRef.current, list = transcriptRef.current;
    const rows = el && list ? rowsInView(el, list, restingCardId.current).map((row) => ({ rowId: row.rowId, contentTop: el.scrollTop - row.offsetWithinRow })) : [];
    anchor.current = el ? { key: transcriptKey, rows, height: el.scrollHeight, from } : null;
  };
  const dragging = useRef(false);
  const setAside = useRef<{ key: string; selection: SetAsideSelection } | null>(null);
  /**
   * `next`, widened over the rows a text selection spans so a step never lets them go. Past the hold's cap a drag keeps
   * `refused` (the drawn window), and anything else sets the selection aside until its rows are drawn again.
   */
  const keepSelection = (next: TranscriptWindowBounds, refused?: TranscriptWindowBounds): TranscriptWindowBounds => {
    const list = transcriptRef.current;
    if (!list || typeof document === "undefined") return next;
    const held = selectedRows(list, (rowId) => rowId.startsWith("live:") ? messages.length - 1 : messages.findIndex((message) => message.id === rowId));
    const kept = held && holdRows(next, messages.length, held);
    if (!held || kept) return kept ?? next;
    if (dragging.current && refused) return refused;
    const aside = setSelectionAside(list);
    if (aside) setAside.current = { key: transcriptKey, selection: aside };
    return next;
  };
  const readingBottom = () => {
    const el = scrollRef.current;
    return Boolean(el) && gapBelow(el!) <= el!.clientHeight;
  };
  const lastTop = useRef(0);
  const movingDown = useRef(false);
  // One visit per conversation: switching back opens where the reader left it, or at the end if they were there.
  const [visit, setVisit] = useState(() => openVisit(transcriptKey, messages));
  const [transcriptWindow, setTranscriptWindow] = useState<HeldWindow>(
    () => ({ key: transcriptKey, first: messages[0]?.id, start: visit.restore?.start ?? tailStart, end: visit.restore?.end ?? null }),
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
  const first = messages[0]?.id;
  const proposed = switched
    ? { start: current.restore?.start ?? tailStart, end: current.restore?.end ?? null, added: -1 }
    : nextWindow(transcriptWindow, messages, following, readingBottom);
  const moves = proposed.start !== transcriptWindow.start || proposed.end !== transcriptWindow.end;
  const next = !switched && moves ? { ...proposed, ...keepSelection(proposed) } : proposed;
  if (switched || next.start !== transcriptWindow.start || next.end !== transcriptWindow.end || first !== transcriptWindow.first) {
    // Rows came in front of the drawn ones or left their top: the DOM is still the last commit's, so it is read now.
    if (!switched && !following && (next.added > 0 || next.start > transcriptWindow.start)) holdRow();
    setTranscriptWindow({ key: transcriptKey, first, start: next.start, end: next.end });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(() => {
    const range = resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end);
    return { ...range, visible: withRestingCard(messages, range.visible, range.startIndex, rests) };
  }, [messages, transcriptWindow.start, transcriptWindow.end, rests]);
  // A switch that opens at the end draws the newest rows first; the rows above them follow after that frame is painted.
  const [firstFrame, setFirstFrame] = useState<{ key: string; from: string } | null>(null);
  if (switched) {
    const jumping = Boolean(focusMessage && !focusMessage.consumed && focusMessage.threadId === threadId);
    const from = current.restore || jumping ? undefined : firstFrameRow(resolveTranscriptWindow(messages, next.start, TRANSCRIPT_WINDOW_SIZE, next.end).visible);
    if (firstFrame?.key !== transcriptKey || firstFrame.from !== from) setFirstFrame(from ? { key: transcriptKey, from } : null);
  }
  const drawFrom = firstFrame?.key === transcriptKey ? firstFrame.from : undefined;
  const drawFromRef = useRef(drawFrom);
  drawFromRef.current = drawFrom;
  const filling = useRef<{ key: string; height: number } | null>(null);
  const fillNow = useCallback(() => {
    const key = followNow.current.key;
    filling.current = { key, height: scrollRef.current?.scrollHeight ?? 0 };
    setFirstFrame((staged) => staged?.key === key ? null : staged);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current, filled = filling.current;
    if (!el) return;
    if (drawFrom) {
      // Newest rows that do not fill the view would show an empty top for a frame: the rest comes before this paint.
      if (el.scrollHeight <= el.clientHeight) fillNow();
      return;
    }
    filling.current = null;
    if (filled?.key !== transcriptKey) return;
    el.scrollTop = followRef.current ? el.scrollHeight : el.scrollTop + el.scrollHeight - filled.height;
    lastTop.current = el.scrollTop;
  }, [drawFrom, fillNow, transcriptKey]);
  useEffect(() => drawFrom ? afterPaint(() => startTransition(fillNow)) : undefined, [drawFrom, fillNow]);
  const windowRef = useRef(transcriptWindow);
  windowRef.current = transcriptWindow;
  restingCardId.current = windowedMessages[0] && windowedMessages[0] !== messages[startIndex] ? windowedMessages[0].id : undefined;
  const drawnBounds: TranscriptWindowBounds = { start: startIndex, end: laterCount > 0 ? endIndex : null };
  const laterRef = useRef(laterCount);
  laterRef.current = laterCount;
  /** At the newest row: the bottom of a window that stops short of it is not the end. */
  const atLiveEnd = (el: HTMLElement | null) => laterRef.current === 0 && atEndOf(el);
  const nearWindowBottom = () => {
    const el = scrollRef.current;
    return laterCount > 0 && Boolean(el) && gapBelow(el!) <= stepAhead(el!);
  };

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

  const nearEnd = () => atLiveEnd(scrollRef.current);
  const noteEnd = useCallback(() => {
    if (scrollRef.current) followEvent({ type: atLiveEnd(scrollRef.current) ? "reachedEnd" : "leftEnd" });
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
    if (!atLiveEnd(scrollRef.current)) followEvent({ type: "leftEnd" });
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
    const top = target();
    if (top === undefined) return;
    el.scrollTop = top;
    lastTop.current = top;
    settleScroll(el, target, () => navigationCount.current !== navigations || followNow.current.key !== current.key);
  }, [current]);

  const appliedFocus = useRef<number | null>(null);
  // Before the follow scroll below: a search jump into the conversation just opened wins over its end.
  useLayoutEffect(() => {
    const focus = focusMessage;
    if (!focus || focus.consumed || focus.threadId !== threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    followEvent({ type: "navigated" });
    followEvent({ type: "leftEnd" });
    if (drawFromRef.current) setFirstFrame(null);
    setTranscriptWindow({ key: transcriptKey, first: messages[0]?.id, ...keepSelection(range) });
  }, [threadId, messages, followEvent, focusMessage, transcriptKey]);
  useFocusMessage(threadId, messages.length > 0, scrollRef);

  // Before paint, so a conversation opens at its end with no frame elsewhere. `follow` is omitted on purpose: re-arming
  // only arms future content and never scrolls.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!followRef.current) return noteLeftEnd();
    el.scrollTo({ top: el.scrollHeight });
    lastTop.current = el.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinOn is the caller's dependency list
  }, [transcriptKey, messages.length, laterCount > 0, ...pinOn]);

  const expandingRef = useRef(false);
  const holdRowForPrepend = () => {
    holdRow();
    setBottomFollow(false);
  };
  // The commit after a window step: the row that was on screen goes back where it was (scroll anchoring is off here),
  // whichever edges gained or lost rows; a switch drops the capture.
  useLayoutEffect(() => {
    const el = scrollRef.current, list = transcriptRef.current, held = anchor.current;
    if (!held || !el) return;
    if (held.key === transcriptKey && held.from?.start === transcriptWindow.start && held.from.end === transcriptWindow.end) return;
    anchor.current = null;
    expandingRef.current = false;
    if (held.key !== transcriptKey) return;
    let moved: number | undefined;
    for (const row of list ? held.rows : []) {
      const top = rowContentTop(el, list!, row.rowId);
      if (top !== undefined) {
        moved = top - row.contentTop;
        break;
      }
    }
    // Rows let go above the reader can leave the content shorter than where they were, and the browser has already
    // pulled scrollTop back to the new end; the last scroll seen is where they were.
    const clamped = el.scrollTop >= el.scrollHeight - el.clientHeight - 1 && lastTop.current > el.scrollTop;
    el.scrollTop = (clamped ? lastTop.current : el.scrollTop) + (moved ?? el.scrollHeight - held.height);
    lastTop.current = el.scrollTop;
  });

  // A selection set aside comes back once both of its rows are drawn again; a click elsewhere lets it go.
  useLayoutEffect(() => {
    const aside = setAside.current, list = transcriptRef.current;
    if (!aside || !list) return;
    if (aside.key !== transcriptKey || restoreSelection(list, aside.selection) !== "waiting") setAside.current = null;
  });
  useEffect(() => {
    const pressed = () => {
      setAside.current = null;
    };
    const released = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerdown", pressed, true);
    window.addEventListener("pointerup", released, true);
    window.addEventListener("pointercancel", released, true);
    return () => {
      window.removeEventListener("pointerdown", pressed, true);
      window.removeEventListener("pointerup", released, true);
      window.removeEventListener("pointercancel", released, true);
    };
  }, []);

  /** Draws the window `step` gives, in a transition so its rows mount between frames; false when there is nothing to draw. */
  const stepWindow = (step: (window: TranscriptWindowBounds, total: number) => TranscriptWindowBounds) => {
    const target = keepSelection(step(drawnBounds, messages.length), drawnBounds);
    if (target.start === drawnBounds.start && target.end === drawnBounds.end) return false;
    holdRow(windowRef.current);
    startTransition(() => setTranscriptWindow((w) => w.key === transcriptKey ? { ...w, ...target } : w));
    return true;
  };
  const showEarlier = () => {
    setBottomFollow(false);
    stepWindow(windowEarlier);
  };
  const showLater = () => {
    setBottomFollow(false);
    stepWindow(windowLater);
  };
  const loadOlder = () => {
    holdRowForPrepend();
    dispatch({ type: "loadOlderMessages", threadId });
  };

  useEffect(() => {
    if (!olderPending) expandingRef.current = false;
  }, [olderPending]);

  // Leaving a conversation lets go of the rows paged in above the window the reader left.
  const leaving = useRef<{ threadId: string; keepFromId: string | undefined } | null>(null);
  useEffect(() => () => {
    const left = leaving.current;
    if (left?.threadId === threadId) dispatch({ type: "trimHeldMessages", threadId, keepFromId: left.keepFromId });
  }, [threadId, dispatch]);
  useEffect(() => {
    leaving.current = { threadId, keepFromId: messages[startIndex]?.id };
  });

  const triggerAutoEarlier = useCallback(() => {
    if (expandingRef.current || drawFromRef.current) return;
    if (hiddenCount > 0) {
      setBottomFollow(false);
      expandingRef.current = stepWindow(windowEarlier);
    } else if (hasMore && !olderPending) {
      expandingRef.current = true;
      holdRowForPrepend();
      dispatch({ type: "loadOlderMessages", threadId });
    }
  }, [hiddenCount, startIndex, laterCount, endIndex, messages.length, hasMore, olderPending, threadId, dispatch, transcriptKey]);
  const triggerAutoLater = () => {
    if (expandingRef.current || drawFromRef.current || laterCount === 0) return;
    expandingRef.current = stepWindow(windowLater);
  };

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !followRef.current && !movingDown.current) {
          triggerAutoEarlier();
        }
      },
      { root, rootMargin: `${STEP_AHEAD_VIEWS * 100}% 0px 0px 0px` },
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
    setTranscriptWindow({ key: transcriptKey, first: messages[0]?.id, ...keepSelection({ start: tailStart, end: null }) });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    });
  };

  const scrollHandlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      // Grabbing the scrollbar is a scroll gesture: its lane lies past clientWidth.
      const el = scrollRef.current;
      if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
      else if (e.button === 0) dragging.current = true;
    },
    onWheel: (e: WheelEvent<HTMLDivElement>) => {
      movingDown.current = e.deltaY > 0;
      if (e.deltaY < 0 && canScrollUp()) {
        setBottomFollow(false);
        const el = scrollRef.current;
        if (el && el.scrollTop <= stepAhead(el)) {
          triggerAutoEarlier();
        }
      } else if (nearEnd()) {
        setBottomFollow(true);
      } else if (e.deltaY > 0 && nearWindowBottom()) {
        triggerAutoLater();
      }
    },
    onTouchStart: (e: TouchEvent<HTMLDivElement>) => {
      touchY.current = e.touches[0]?.clientY ?? 0;
    },
    onTouchMove: (e: TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY ?? 0;
      movingDown.current = y < touchY.current;
      if (y > touchY.current + 4 && canScrollUp()) {
        setBottomFollow(false);
        const el = scrollRef.current;
        if (el && el.scrollTop <= stepAhead(el)) {
          triggerAutoEarlier();
        }
      } else if (nearEnd()) {
        setBottomFollow(true);
      } else if (movingDown.current && nearWindowBottom()) {
        triggerAutoLater();
      }
    },
    onScroll: () => {
      const el = scrollRef.current;
      if (!el) return;
      const moved = el.scrollTop - lastTop.current;
      lastTop.current = el.scrollTop;
      if (moved !== 0) movingDown.current = moved > 0;
      noteEnd();
      recordPosition();
      if (followRef.current) return;
      // Each edge steps only on a move toward it, so the scrollTop set after a step never steps the other way.
      if (moved < 0 && el.scrollTop <= stepAhead(el)) triggerAutoEarlier();
      else if (moved > 0 && nearWindowBottom()) triggerAutoLater();
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
    /** While a switch draws its first frame: the oldest row drawn. */
    drawFrom,
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
