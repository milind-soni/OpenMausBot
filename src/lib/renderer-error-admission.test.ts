import { describe, expect, it } from "vitest";

import { createRendererErrorAdmission, RENDERER_ERROR_REPORT_LIMIT } from "./renderer-error-admission";

describe("renderer error admission", () => {
  it("admits at most twenty unique signatures and suppresses duplicates", () => {
    const admit = createRendererErrorAdmission();
    expect(admit("duplicate")).toBe(true);
    expect(admit("duplicate")).toBe(false);
    for (let index = 1; index < RENDERER_ERROR_REPORT_LIMIT; index += 1) {
      expect(admit(`unique-${index}`)).toBe(true);
    }
    expect(admit("over-limit")).toBe(false);
  });
});
