// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// The store reaches server-only modules; this test only needs the bubble's own DOM.
vi.mock("@/state/store", () => ({ api: vi.fn(), ApiError: class ApiError extends Error {}, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { VoiceNoteBubble } from "./VoiceNoteBubble";

const note = {
  kind: "audio" as const,
  path: "/attachments/123e4567-e89b-12d3-a456-426614174000.mp3",
  mime: "audio/mpeg",
  durationMs: 4200,
  text: "Deploy is green, every check passed.",
};

function render() {
  const container = document.createElement("div"), root = createRoot(container);
  flushSync(() => root.render(createElement(VoiceNoteBubble, { attachment: note })));
  return { container, root };
}

describe("the voice note's transcript disclosure", () => {
  it("opens on a tap and closes on the next, never showing the words until asked", () => {
    const { container, root } = render();
    try {
      const toggle = container.querySelector<HTMLButtonElement>("button[data-test-voice-note-transcript]")!;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).toContain("Transcript");
      expect(container.textContent).not.toContain("Deploy is green");

      flushSync(() => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("Deploy is green, every check passed.");

      flushSync(() => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("Deploy is green");
    } finally {
      root.unmount();
    }
  });
});
