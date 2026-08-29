import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const shellSource = readFileSync(
  new URL("../src/components/centipede/CentipedeDesktopShell.tsx", import.meta.url),
  "utf8",
);
const shellStyles = readFileSync(
  new URL("../src/components/centipede/centipede-desktop.css", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");

describe("Agent Centipede clinical precision shell", () => {
  it("renders live instrumentation rather than placeholder dashboard art", () => {
    expect(shellSource).toContain("ActivitySparkline");
    expect(shellSource).toContain("healthSegmentCount");
    expect(shellSource).toContain("centipede-health-meter");
    expect(shellStyles).toContain(".centipede-stat-sparkline");
    expect(shellStyles).toContain(".centipede-health-meter");
  });

  it("keeps the clinical identity code-native without a decorative specimen card", () => {
    expect(sidebarSource).toContain("CentipedeBrand");
    expect(sidebarSource).not.toContain("centipede-specimen-card");
    expect(shellStyles).not.toContain(".centipede-specimen-card");
  });

  it("shows the mission stages and evidence signals while work is active", () => {
    expect(shellSource).toContain("centipede-mission-stages");
    expect(shellSource).toContain("activityMessages");
    expect(shellSource).toContain("screenSignals");
  });

  it("uses a low-contrast clinical grid without changing content semantics", () => {
    expect(shellStyles).toMatch(/\.centipede-desktop-content\s*>\s*main[\s\S]*background-size:\s*28px 28px/);
  });
});
