import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Hold the scene on one phase; the timers that advance it never run here.
const scene = vi.hoisted(() => ({ phase: "chat" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [scene.phase, () => {}],
  useEffect: () => {},
}));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/lib/onboarding", () => ({ reducedMotion: () => false }));
import { Hands } from "./Hands";

function render(phase: string): string {
  scene.phase = phase;
  return renderToStaticMarkup(createElement(Hands, { playing: true, label: "They have hands" }));
}

describe("Hands scene", () => {
  // Someone clicking through the reel lands on the panel's first second.
  // A spinner and "Starting…" there read as a broken demo, not a bot at work.
  it("shows the booking page, not a loading screen, from the moment the panel is in", () => {
    for (const phase of ["panel", "awake", "moving", "clicked", "done", "reply"]) {
      const html = render(phase);
      expect(html, phase).not.toContain("Connecting to the screen");
      expect(html, phase).not.toContain("Starting…");
      expect(html, phase).toContain("Cloud screen connected");
      expect(html, phase).toContain("clinic.example/book");
      expect(html, phase).not.toMatch(/\bopacity-0\b/);
    }
  });
});
