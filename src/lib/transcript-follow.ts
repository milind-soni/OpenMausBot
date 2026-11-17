/**
 * Whether the transcript keeps its live end in view. `atEnd` only matters once released: while following, the
 * transcript is at its end by definition.
 */
export type TranscriptFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean };

export type TranscriptFollowEvent =
  /** The person moved the transcript away from where it follows: a scroll up, a scroll key, a scrollbar grab. */
  | { readonly type: "navigated" }
  /** The person asked for the end: they sent a message, pressed "latest", or pulled down at the end. */
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" };

export const FOLLOWING: TranscriptFollow = { mode: "following" };

export function initialTranscriptFollow(followEnd: boolean): TranscriptFollow {
  return followEnd ? FOLLOWING : { mode: "released", atEnd: false };
}

export function transitionTranscriptFollow(state: TranscriptFollow, event: TranscriptFollowEvent): TranscriptFollow {
  switch (event.type) {
    case "navigated":
      return state.mode === "released" ? state : { mode: "released", atEnd: true };
    case "followEnd":
      return FOLLOWING;
    case "reachedEnd":
      // A scroll key pressed at the end stays released until the transcript has left the end and come back.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
    case "leftEnd":
      // While following, every streamed chunk leaves the end band for a frame before the follow scroll catches up.
      return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
  }
}

/** The "latest" button shows once the reader has left the end; it waits a moment so a switch or a settle never flashes it. */
export const JUMP_TO_LATEST_DELAY_MS = 150;

export function wantsJumpToLatest(state: TranscriptFollow): boolean {
  return state.mode === "released" && !state.atEnd;
}

/** Where the reader left a conversation: the row at the top of the view and how far it was scrolled past, or the end. */
export interface RememberedTranscriptPosition {
  readonly atEnd: boolean;
  readonly rowId?: string;
  readonly offsetWithinRow?: number;
  readonly windowStart?: number;
  readonly windowEnd?: number | null;
}

const MAX_REMEMBERED = 100;
const remembered = new Map<string, RememberedTranscriptPosition>();

export function readTranscriptPosition(key: string): RememberedTranscriptPosition | undefined {
  return remembered.get(key);
}

export function rememberTranscriptPosition(key: string, position: RememberedTranscriptPosition): void {
  remembered.delete(key);
  remembered.set(key, position);
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
}

/** Tests only. */
export function forgetTranscriptPositions(): void {
  remembered.clear();
}

/** A row's box: transcript rows are `display: contents`, so their own box is empty and their content's is used. */
function rowBox(row: Element): { top: number; bottom: number } {
  const own = row.getBoundingClientRect();
  if (own.height > 0 || typeof document === "undefined" || typeof document.createRange !== "function") return own;
  const range = document.createRange();
  range.selectNodeContents(row);
  return range.getBoundingClientRect();
}

const ROW_SELECTOR = "[data-mid]";

/** The first saved row at the top of the view, and how far above the view's top its own top lies. */
export function topRow(scroller: HTMLElement, transcript: HTMLElement): { rowId: string; offsetWithinRow: number } | null {
  if (typeof transcript.querySelectorAll !== "function") return null;
  const top = scroller.getBoundingClientRect().top;
  for (const row of Array.from(transcript.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const rowId = row.dataset.mid;
    if (!rowId || rowId.startsWith("live:")) continue;
    const box = rowBox(row);
    if (box.bottom > top) return { rowId, offsetWithinRow: top - box.top };
  }
  return null;
}

/** The scrollTop that puts `rowId` back where `topRow` found it, or undefined when the row is not drawn. */
export function rowScrollTop(scroller: HTMLElement, transcript: HTMLElement, rowId: string, offsetWithinRow: number): number | undefined {
  if (typeof transcript.querySelectorAll !== "function") return undefined;
  const row = Array.from(transcript.querySelectorAll<HTMLElement>(ROW_SELECTOR)).find((candidate) => candidate.dataset.mid === rowId);
  if (!row) return undefined;
  const target = scroller.scrollTop + rowBox(row).top - scroller.getBoundingClientRect().top + offsetWithinRow;
  return Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
}

// A streaming reply moves the end every frame, so the target may never hold still: past this many frames, follow's own
// growth handling takes over.
const SETTLE_MAX_FRAMES = 60;

/**
 * Layout after a switch is not final in the first frame (code colouring, images, fonts), so a restored position is
 * corrected against the DOM until it holds for two frames, the frame budget runs out, or the caller cancels.
 */
export function settleScroll(scroller: HTMLElement, target: () => number | undefined, cancelled: () => boolean): void {
  let stableFrames = 0;
  let frames = 0;
  const reconcile = () => {
    if (cancelled()) return;
    const offset = target();
    frames += 1;
    if (offset === undefined || frames > SETTLE_MAX_FRAMES) return;
    if (Math.abs(scroller.scrollTop - offset) > 1) {
      stableFrames = 0;
      scroller.scrollTop = offset;
    } else if (++stableFrames >= 2) return;
    requestAnimationFrame(reconcile);
  };
  requestAnimationFrame(reconcile);
}
