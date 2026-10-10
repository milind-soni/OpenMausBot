import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {};
});
void fixture;

const { VoiceNoteBubble } = await import("./VoiceNoteBubble");
const { configureLiveMedia, resetLiveMedia, startLiveCall } = await import("@/lib/live-call-media");
afterAll(() => vi.unstubAllGlobals());

const note = {
  kind: "audio" as const,
  path: "/attachments/123e4567-e89b-12d3-a456-426614174000.mp3",
  mime: "audio/mpeg",
  durationMs: 4200,
};

describe("VoiceNoteBubble", () => {
  it("renders a paused player with the metadata duration estimate and no autoplay", () => {
    const markup = renderToStaticMarkup(createElement(VoiceNoteBubble, { attachment: note }));
    expect(markup).toContain('aria-label="Play voice note"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('aria-label="Seek voice note"');
    expect(markup).toContain('max="4.2"');
    expect(markup).toContain("0:00");
    expect(markup).toContain("0:04");
    expect(markup).not.toContain("autoplay");
    expect(markup).toContain('src="/api/attachments/123e4567-e89b-12d3-a456-426614174000.mp3"');
    expect(markup).toContain('preload="metadata"');
  });

  it("renders no player for a path that is not a parked generated mp3", () => {
    const markup = renderToStaticMarkup(
      createElement(VoiceNoteBubble, { attachment: { ...note, path: "/attachments/note.wav" } }),
    );
    expect(markup).toBe("");
  });

  // A note played over a Live call is heard by the call's microphone (and on
  // Android it ended the call): the play button waits, and says why.
  it("cannot be played while this window is on a Live call, and says why", () => {
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: "b1", threadId: "t1" });
    try {
      const markup = renderToStaticMarkup(createElement(VoiceNoteBubble, { attachment: note }));
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Voice notes can&#x27;t play during a Live call."/);
    } finally {
      resetLiveMedia();
    }
    expect(renderToStaticMarkup(createElement(VoiceNoteBubble, { attachment: note }))).toContain('aria-label="Play voice note"');
  });
});
