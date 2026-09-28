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
});
