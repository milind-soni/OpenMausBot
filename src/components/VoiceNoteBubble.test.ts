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

  it("plays a WAV note from the built-in Mac voices", () => {
    const markup = renderToStaticMarkup(
      createElement(VoiceNoteBubble, { attachment: { ...note, path: "/attachments/note.wav", mime: "audio/wav" } }),
    );
    expect(markup).toContain('src="/api/attachments/note.wav"');
  });

  it("renders no player for a path that is not a parked generated mp3 or wav", () => {
    const markup = renderToStaticMarkup(
      createElement(VoiceNoteBubble, { attachment: { ...note, path: "/attachments/note.ogg" } }),
    );
    expect(markup).toBe("");
  });

  it("keeps the note's words behind a Transcript disclosure that starts collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(VoiceNoteBubble, { attachment: { ...note, text: "Deploy is green, every check passed." } }),
    );
    expect(markup).toMatch(/<button[^>]*data-test-voice-note-transcript=""[^>]*aria-expanded="false"/);
    expect(markup).toContain("Transcript");
    expect(markup).not.toContain("Deploy is green");
  });

  it("shows no disclosure for a note without words, as every note stored before the transcript field", () => {
    const markup = renderToStaticMarkup(createElement(VoiceNoteBubble, { attachment: note }));
    expect(markup).not.toContain("data-test-voice-note-transcript");
    expect(markup).not.toContain("Transcript");
    expect(renderToStaticMarkup(createElement(VoiceNoteBubble, { attachment: { ...note, text: "   " } }))).not.toContain("Transcript");
  });

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
