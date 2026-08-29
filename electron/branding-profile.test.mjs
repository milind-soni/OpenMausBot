import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const canonicalIcon = readFileSync(new URL("../build/icon-1024.png", import.meta.url));
const packagedRuntimeIcon = readFileSync(new URL("./resources/app-icon.png", import.meta.url));

describe("Agent Centipede desktop identity", () => {
  it("keeps the established OpenMaus Electron profile during the rename", () => {
    const branded = source.indexOf('app.setName("Agent Centipede")');
    const pinnedProfile = source.indexOf(
      'app.setPath("userData", path.join(app.getPath("appData"), "openmausbot"))',
    );

    expect(branded).toBeGreaterThan(-1);
    expect(pinnedProfile).toBeGreaterThan(branded);
  });

  it("packages the canonical Centipede artwork for Windows notifications", () => {
    expect(packagedRuntimeIcon).toEqual(canonicalIcon);
  });
});
