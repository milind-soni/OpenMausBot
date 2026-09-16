import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies.ts";

// P1 ruling: emitted to ios/Sources/CompanionCore (reachable by `swift test`),
// not ios/App (the Xcode app target, which `swift test` never builds).
const swift = readFileSync(
  new URL("../../ios/Sources/CompanionCore/AstraBodies.swift", import.meta.url),
  "utf8"
);

describe("the generated Swift catalog", () => {
  it("warns against hand-editing, like AstraFaceData does", () => {
    expect(swift).toContain("do not hand-edit");
  });

  it("declares every body the TypeScript catalog has", () => {
    for (const id of MASCOT_BODY_IDS) {
      expect(swift, `${id} missing from Swift`).toContain(`"${id}"`);
    }
  });

  it("defaults to the cursor", () => {
    expect(swift).toContain('static let defaultID = "cursor"');
  });

  it("carries the same anchors as the TypeScript catalog", () => {
    for (const id of MASCOT_BODY_IDS) {
      const { anchor } = MASCOT_BODIES[id];
      expect(swift, `${id} anchor.x`).toContain(`x: ${anchor.x}`);
      expect(swift, `${id} anchor.y`).toContain(`y: ${anchor.y}`);
    }
  });

  it("emits only the path commands the iOS parser understands", () => {
    for (const match of swift.matchAll(/path:\s*"""\n([\s\S]*?)\n\s*"""/g)) {
      const unique = [...new Set(match[1].match(/[A-Za-z]/g) ?? [])].sort();
      expect(unique.filter(c => !"e".includes(c))).toEqual(["C", "M", "Z"]);
    }
  });

  it("does not import SwiftUI — CompanionCore is view-free", () => {
    expect(swift).not.toContain("import SwiftUI");
  });

  it("emits the fit transform as numbers, not the SVG transform string", () => {
    expect(swift).toMatch(/fit:\s*\(scale:\s*-?\d/);
  });
});
