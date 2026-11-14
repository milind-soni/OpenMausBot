import type { LocaleKey } from "@/locales";

export type ScreenPreviewFailurePhase = "cancelled" | "unavailable" | "error";

export type ScreenPreviewStartResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; phase: ScreenPreviewFailurePhase; messageKey: LocaleKey };

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
      messageKey: "computer.screen.cancelled",
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
      messageKey: "computer.screen.unavailableNow",
    };
  }
  return { ok: false, phase: "error", messageKey: "computer.screen.error" };
}

export async function requestScreenPreview({
  beginIntent,
  getDisplayMedia,
}: ScreenPreviewRequest): Promise<ScreenPreviewStartResult> {
  try {
    // Synchronous and adjacent: Chromium must see the media request in the same user gesture.
    if (!beginIntent()) {
      return {
        ok: false,
        phase: "unavailable",
        messageKey: "computer.screen.unavailableWindow",
      };
    }
    const stream = await getDisplayMedia({ video: true, audio: false });
    if (stream.getVideoTracks().length === 0) {
      stopScreenPreview(stream);
      return {
        ok: false,
        phase: "unavailable",
        messageKey: "computer.screen.noVideoTrack",
      };
    }
    return { ok: true, stream };
  } catch (error) {
    return screenPreviewFailure(error);
  }
}
