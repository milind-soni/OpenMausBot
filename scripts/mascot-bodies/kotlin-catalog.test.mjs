import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies.ts";

// Emitted into the Android app module, whose JVM unit tests (Robolectric) parse
// the catalog the way `swift test` does for CompanionCore — see swift-catalog.test.mjs.
const kotlin = readFileSync(
  new URL("../../android/app/src/main/kotlin/com/astra/companion/ui/AstraBodies.kt", import.meta.url),
  "utf8"
);

describe("the generated Kotlin catalog", () => {
  it("warns against hand-editing, like the Swift does", () => {
    expect(kotlin).toContain("do not hand-edit");
  });

  it("declares every body the TypeScript catalog has", () => {
    for (const id of MASCOT_BODY_IDS) {
      expect(kotlin, `${id} missing from Kotlin`).toContain(`"${id}" to Body(`);
    }
  });

  it("defaults to the cursor", () => {
    expect(kotlin).toContain('const val DEFAULT_ID: String = "cursor"');
  });

  it("carries the same anchors as the TypeScript catalog", () => {
    for (const id of MASCOT_BODY_IDS) {
      const { anchor } = MASCOT_BODIES[id];
      expect(kotlin, `${id} anchor.x`).toContain(`anchorX = ${anchor.x}f`);
      expect(kotlin, `${id} anchor.y`).toContain(`anchorY = ${anchor.y}f`);
      expect(kotlin, `${id} anchor.scale`).toContain(`anchorScale = ${anchor.scale}f`);
    }
  });

  it("emits only the path commands the Android parser is asked to read", () => {
    for (const match of kotlin.matchAll(/path =\s*"""\n([\s\S]*?)\n\s*"""/g)) {
      const unique = [...new Set(match[1].match(/[A-Za-z]/g) ?? [])].sort();
      expect(unique.filter(c => !"e".includes(c))).toEqual(["C", "M", "Z"]);
    }
  });

  it("does not import Compose — the catalog is data", () => {
    expect(kotlin).not.toContain("import androidx");
  });

  it("emits the fit and tight bounds as Float literals", () => {
    expect(kotlin).toMatch(/fitScale = -?\d[\d.e-]*f/);
    expect(kotlin).toMatch(/left = -?\d[\d.e-]*f/);
    expect(kotlin).toMatch(/bottom = -?\d[\d.e-]*f/);
  });
});
