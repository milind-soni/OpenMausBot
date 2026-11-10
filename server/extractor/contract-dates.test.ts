import { describe, expect, it } from "vitest";

import { typedValue } from "./contract.ts";

describe("extracted calendar dates", () => {
  it.each(["2026-02-29", "2026-02-30", "2024-02-30", "1900-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "2026-2-01"])(
    "rejects the nonexistent or malformed date %s", (value) => {
      expect(typedValue({ type: "date" }, value)).toBeUndefined();
    },
  );

  it.each(["2024-02-29", "2000-02-29", "2026-04-30", "2026-12-31", "0099-01-01"])("preserves the valid date %s", (value) => {
    expect(typedValue({ type: "date" }, value)).toBe(value);
  });

  it.each([null, undefined])("retains the missing-date contract for %s", (value) => {
    expect(typedValue({ type: "date" }, value)).toBeNull();
  });
});
