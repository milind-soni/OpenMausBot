import { describe, expect, it } from "vitest";

import { loadLocale, setLocale } from "./i18n";
import { formatPlanSpend } from "./plan-spend";

describe("formatPlanSpend", () => {
  it("scales minor units by the provider's exponent", () => {
    expect(formatPlanSpend({ usedMinor: 4_631, limitMinor: 50_000, currency: "USD", exponent: 2 })).toBe("$46.31 of $500.00 spent");
    expect(formatPlanSpend({ usedMinor: 1_200, limitMinor: 50_000, currency: "JPY", exponent: 0 })).toBe("¥1,200 of ¥50,000 spent");
  });

  it("writes money the way the app's language does, whatever the computer's", async () => {
    await loadLocale("de");
    try {
      expect(formatPlanSpend({ usedMinor: 4_631, limitMinor: 50_000, currency: "EUR", exponent: 2 })).toContain("46,31");
    } finally {
      setLocale("en");
    }
  });

  it("names a currency Intl has no symbol for", () => {
    expect(formatPlanSpend({ usedMinor: 100, limitMinor: 1_000, currency: "XYZ", exponent: 2 })).toMatch(/XYZ\s1\.00 of XYZ\s10\.00 spent/);
  });

  it("falls back to plain digits when Intl refuses", () => {
    expect(formatPlanSpend({ usedMinor: 100, limitMinor: 1_000, currency: "not money", exponent: 2 })).toBe("1.00 not money of 10.00 not money spent");
  });
});
