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
const chatSource = readFileSync(new URL("../src/components/ChatView.tsx", import.meta.url), "utf8");
const groupSource = readFileSync(new URL("../src/components/GroupView.tsx", import.meta.url), "utf8");

describe("Windows title-bar layout", () => {
  it("owns a dedicated shell row instead of covering product controls", () => {
    expect(shellSource).toContain("centipede-window-titlebar");
    expect(shellStyles).toMatch(/\.centipede-desktop-shell\.is-windows\s*\{[^}]*grid-template-rows:\s*40px minmax\(0,\s*1fr\)/s);
    expect(shellStyles).toMatch(/\.centipede-window-titlebar\s*\{[^}]*grid-column:\s*2\s*\/\s*-1/s);
    expect(shellStyles).toMatch(/\.centipede-window-titlebar\s*\{[^}]*-webkit-app-region:\s*drag/s);
  });

  it("keeps caption clearance out of nested conversation headers", () => {
    expect(chatSource).not.toContain('isWin && "pr-[148px]"');
    expect(groupSource).not.toContain('isWin && "pr-[148px]"');
  });
});
