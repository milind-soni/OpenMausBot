import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/components/centipede/centipede-desktop.css", import.meta.url),
  "utf8",
);

describe("Agent Centipede motion system", () => {
  it("uses restrained entrance, interaction, and live-state motion", () => {
    expect(styles).toContain("@keyframes centipede-shell-in");
    expect(styles).toContain("@keyframes centipede-content-in");
    expect(styles).toContain("@keyframes centipede-live-breathe");
    expect(styles).toContain("@keyframes centipede-stage-in");
    expect(styles).toContain(".centipede-agent-row:hover");
  });

  it("turns off the custom motion when reduced motion is requested", () => {
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.centipede-desktop-shell[\s\S]*animation:\s*none/);
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.centipede-agent-row[\s\S]*transform:\s*none/);
  });
});
