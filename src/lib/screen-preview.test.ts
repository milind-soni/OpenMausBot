import { describe, expect, it, vi } from "vitest";

import {
  requestScreenPreview,
  screenPreviewFailure,
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
