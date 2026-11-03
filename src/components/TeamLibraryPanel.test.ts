import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./TeamLibraryPanel.tsx", import.meta.url), "utf8");

describe("TeamLibraryPanel", () => {
  it("dims the app behind Templates without a full-window backdrop blur", () => {
    // Without a GPU (software rendering) a full-window blur is redrawn on every frame, so the page lags while it is open.
    const overlay = source.match(/className="(fixed inset-0 [^"]*)"/)?.[1];
    expect(overlay).toContain("bg-black/55");
    expect(source).not.toMatch(/backdrop-blur|backdrop-filter|backdropFilter/);
  });
});
