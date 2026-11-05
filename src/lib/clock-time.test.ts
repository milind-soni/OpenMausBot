import { afterEach, describe, expect, it, vi } from "vitest";

import { clockOptions, formatTime, namesLocale } from "./clock-time";
import { formatTime as legacyFormatTime } from "./format-time";
import { setLocale } from "./i18n";
import { niceTime } from "./schedule-label";

const at = new Date(2026, 9, 23, 9, 5).getTime();

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("a time of day", () => {
  it("shares the active clock with the legacy import and follows language changes", () => {
    expect(legacyFormatTime).toBe(formatTime);
    vi.stubGlobal("navigator", { language: "en-US" });
    const english = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    expect(formatTime(at)).toBe(english);
    setLocale("pt-br");
    expect(formatTime(at)).toBe("09:05");
    setLocale("en");
    expect(formatTime(at)).toBe(english);
  });

  it("localizes invalid dates without changing the English fallback", () => {
    expect(formatTime(NaN)).toBe("Invalid Date");
    setLocale("pt-br");
    expect(formatTime(NaN)).toBe("Data inválida");
  });

  it("keeps an English app's clock exactly as before, whatever the browser's region", () => {
    for (const region of ["en-US", "en-GB"]) {
      vi.stubGlobal("navigator", { language: region });
      setLocale("en");
      const before = new Date(at).toLocaleTimeString(region, { hour: "numeric", minute: "2-digit" });
      expect([formatTime(at), niceTime(at)], region).toEqual([before, before]);
      expect(clockOptions(region, true), region).toEqual({ hour: "numeric" });
      expect(namesLocale(), region).toBe("en-US");
    }
  });

  it("writes a 24-hour clock with two-digit hours and the minutes in pt-BR", () => {
    setLocale("pt-br");
    expect([formatTime(at), niceTime(at)]).toEqual(["09:05", "09:05"]);
    expect(clockOptions("pt-BR", true)).toEqual({ hour: "2-digit", minute: "2-digit" });
  });
});
