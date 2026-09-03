import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestScreenPreview,
  screenPreviewFailure,
  SCREEN_FRAME_CADENCE_MS,
  SCREEN_FRAME_FIRST_RETRY_MS,
  startScreenFramePoll,
  stopScreenPreview,
} from "./screen-preview";

function fakeStream(videoTracks = 1, totalTracks = videoTracks) {
  const tracks = Array.from({ length: totalTracks }, () => ({ stop: vi.fn() }));
  return {
    stream: {
      getTracks: () => tracks,
      getVideoTracks: () => tracks.slice(0, videoTracks),
    } as unknown as MediaStream,
    tracks,
  };
}

describe("screen preview request", () => {
  it("does nothing until start is called, then arms intent before requesting video-only media", async () => {
    const beginIntent = vi.fn(() => true);
    const { stream } = fakeStream();
    const getDisplayMedia = vi.fn(async () => stream);

    expect(beginIntent).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();

    await expect(requestScreenPreview({ beginIntent, getDisplayMedia })).resolves.toEqual({
      ok: true,
      stream,
    });
    expect(beginIntent).toHaveBeenCalledOnce();
    expect(beginIntent.mock.invocationCallOrder[0]).toBeLessThan(
      getDisplayMedia.mock.invocationCallOrder[0],
    );
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });

  it("stops a stream that contains no video track", async () => {
    const { stream, tracks } = fakeStream(0, 1);
    const result = await requestScreenPreview({
      beginIntent: vi.fn(() => true),
      getDisplayMedia: vi.fn(async () => stream),
    });

    expect(result).toMatchObject({ ok: false, phase: "unavailable" });
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not request media when the desktop host rejects preview intent", async () => {
    const getDisplayMedia = vi.fn();

    await expect(
      requestScreenPreview({ beginIntent: () => false, getDisplayMedia }),
    ).resolves.toMatchObject({ ok: false, phase: "unavailable" });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("normalizes a cancelled chooser and stops every live track", () => {
    expect(screenPreviewFailure(new DOMException("cancelled", "AbortError"))).toMatchObject({
      ok: false,
      phase: "cancelled",
    });
    const { stream, tracks } = fakeStream(2);
    stopScreenPreview(stream);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });
});

describe("local screen frame poll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries Windows' first frame quickly, then uses busy cadence", async () => {
    const capture = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("data:image/png;base64,frame")
      .mockResolvedValue(null);
    const onFrame = vi.fn();
    const onMiss = vi.fn();
    const cancel = startScreenFramePoll({
      capture,
      onFrame,
      onMiss,
      busy: true,
      firstFrameRetryMs: SCREEN_FRAME_FIRST_RETRY_MS,
    });

    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_FIRST_RETRY_MS);
    expect(capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_FIRST_RETRY_MS);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(onFrame).toHaveBeenCalledWith("data:image/png;base64,frame");

    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_CADENCE_MS.busy - 1);
    expect(capture).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(4);
    cancel();
  });

  it("keeps the idle cadence and cancels the cadence after cleanup", async () => {
    const capture = vi.fn<() => Promise<string | null>>().mockResolvedValue("frame");
    const onFrame = vi.fn();
    const cancel = startScreenFramePoll({ capture, onFrame, busy: false, firstFrameRetryMs: null });

    await Promise.resolve();
    expect(capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_CADENCE_MS.idle - 1);
    expect(capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(capture).toHaveBeenCalledTimes(2);
    cancel();
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_CADENCE_MS.idle);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("does not publish a frame after cleanup while capture is in flight", async () => {
    let resolve!: (frame: string) => void;
    const capture = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const onFrame = vi.fn();
    const cancel = startScreenFramePoll({
      capture,
      onFrame,
      busy: true,
      firstFrameRetryMs: SCREEN_FRAME_FIRST_RETRY_MS,
    });

    cancel();
    resolve("late-frame");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(SCREEN_FRAME_FIRST_RETRY_MS * 2);
    expect(onFrame).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledOnce();
  });
});
