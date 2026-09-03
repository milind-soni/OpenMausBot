export type ScreenPreviewFailurePhase = "cancelled" | "unavailable" | "error";

export type ScreenPreviewStartResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; phase: ScreenPreviewFailurePhase; message: string };

export const SCREEN_FRAME_FIRST_RETRY_MS = 250;
export const SCREEN_FRAME_CADENCE_MS = {
  busy: 3_000,
  idle: 30_000,
} as const;

interface ScreenFramePollOptions {
  capture: () => Promise<string | null>;
  onFrame: (frame: string) => void;
  onMiss?: () => void;
  busy: boolean;
  /** Windows needs a short retry loop while Electron warms its first capture.
   * null preserves the existing macOS cadence from the first attempt. */
  firstFrameRetryMs?: number | null;
}

/** Start a visibility-scoped local screen poll and return its cancellation
 * function. A first-frame retry loop is intentionally separate from the
 * steady-state cadence so a successful capture never creates two timers. */
export function startScreenFramePoll({
  capture,
  onFrame,
  onMiss,
  busy,
  firstFrameRetryMs = null,
}: ScreenFramePollOptions): () => void {
  let cancelled = false;
  let inFlight = false;
  let hasFrame = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let cadenceTimer: ReturnType<typeof setInterval> | null = null;

  const startCadence = () => {
    if (cancelled || cadenceTimer !== null) return;
    cadenceTimer = globalThis.setInterval(
      () => void shoot(),
      busy ? SCREEN_FRAME_CADENCE_MS.busy : SCREEN_FRAME_CADENCE_MS.idle,
    );
  };

  const scheduleFirstRetry = () => {
    if (cancelled || hasFrame || firstFrameRetryMs == null || retryTimer !== null) return;
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = null;
      void shoot();
    }, firstFrameRetryMs);
  };

  const shoot = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      const frame = await capture();
      if (cancelled) return;
      if (frame) {
        hasFrame = true;
        onFrame(frame);
        if (retryTimer !== null) {
          globalThis.clearTimeout(retryTimer);
          retryTimer = null;
        }
        startCadence();
      } else {
        onMiss?.();
        scheduleFirstRetry();
      }
    } catch {
      if (cancelled) return;
      onMiss?.();
      scheduleFirstRetry();
    } finally {
      inFlight = false;
    }
  };

  if (firstFrameRetryMs == null) startCadence();
  void shoot();

  return () => {
    cancelled = true;
    if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
    if (cadenceTimer !== null) globalThis.clearInterval(cadenceTimer);
    retryTimer = null;
    cadenceTimer = null;
  };
}

type ScreenPreviewRequest = {
  beginIntent: () => boolean;
  getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
};

export function stopScreenPreview(stream: Pick<MediaStream, "getTracks"> | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function screenPreviewFailure(error: unknown): Exclude<ScreenPreviewStartResult, { ok: true }> {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return {
      ok: false,
      phase: "cancelled",
      message: "Screen selection was cancelled. Nothing is being shared.",
    };
  }
  if (
    name === "NotFoundError" ||
    name === "NotReadableError" ||
    name === "NotSupportedError" ||
    name === "SecurityError"
  ) {
    return {
      ok: false,
      phase: "unavailable",
      message: "Screen preview isn't available right now.",
    };
  }
  return { ok: false, phase: "error", message: "Couldn't start screen preview." };
}

export async function requestScreenPreview({
  beginIntent,
  getDisplayMedia,
}: ScreenPreviewRequest): Promise<ScreenPreviewStartResult> {
  try {
    // Keep these synchronous and adjacent so Chromium sees the media request
    // in the same user gesture that armed the one-shot main-process intent.
    if (!beginIntent()) {
      return {
        ok: false,
        phase: "unavailable",
        message: "Screen preview isn't available from this window.",
      };
    }
    const stream = await getDisplayMedia({ video: true, audio: false });
    if (stream.getVideoTracks().length === 0) {
      stopScreenPreview(stream);
      return {
        ok: false,
        phase: "unavailable",
        message: "The selected source did not provide a video stream.",
      };
    }
    return { ok: true, stream };
  } catch (error) {
    return screenPreviewFailure(error);
  }
}
