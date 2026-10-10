import { describe, expect, it } from "vitest";

import { BODY_DEFS, BODY_IDS } from "./builders.ts";

const EXPECTED_IDS = [
  "cursor", "blob", "circle", "squircle", "capsule",
  "drop", "shield", "hexagon", "diamond", "star",
];

describe("body builders", () => {
  it("produces the catalog in its persisted order, cursor first", () => {
    expect(BODY_IDS).toEqual(EXPECTED_IDS);
  });

  it("emits only absolute M, C and Z, which is all the iOS parser understands", () => {
    for (const body of BODY_DEFS) {
      const commands = body.d.match(/[A-Za-z]/g) ?? [];
      const unique = [...new Set(commands)].sort();
      expect(unique, `${body.id} uses unsupported commands`).toEqual(["C", "M", "Z"]);
    }
  });

  it("starts every outline with a move and closes it", () => {
    for (const body of BODY_DEFS) {
      expect(body.d.trimStart().startsWith("M"), body.id).toBe(true);
      expect(body.d.trimEnd().endsWith("Z"), body.id).toBe(true);
    }
  });

  it("gives every curve six numbers", () => {
    for (const body of BODY_DEFS) {
      for (const segment of body.d.split("C").slice(1)) {
        const numbers = segment.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
        expect(numbers.length % 6, `${body.id} has a ragged curve`).toBe(0);
      }
    }
  });

  it("keeps the cursor outline byte-identical to the shipped artwork", () => {
    const cursor = BODY_DEFS.find(s => s.id === "cursor");
    expect(cursor.d.startsWith("M0 0 C1.12815992 0.94880479")).toBe(true);
    expect(cursor.d.trimEnd().endsWith("-21.34867451 -18.24899383 0 0 Z")).toBe(true);
  });
});
