import { describe, expect, it } from "vitest";

import { setLanguageChoice } from "./language-preference";
import { duePing, openTarget, PRESENCE_MIN_INTERVAL_MS, presenceBody, shownLanguage } from "./presence-client";

describe("presence client", () => {
  it("sends the device's zone and the app's language with the desktop source", () => {
    expect(presenceBody("Asia/Kolkata", "pt-br")).toEqual({ source: "desktop", timeZone: "Asia/Kolkata", language: "pt-br" });
    expect(presenceBody("", "en")).toEqual({ source: "desktop", language: "en" });
  });

  it("names the pack the app shows: the device's pick, else the server's language", () => {
    expect(shownLanguage("pt-BR")).toBe("pt-br");
    setLanguageChoice("es");
    expect(shownLanguage("pt-br")).toBe("es");
  });

  it("pings once a minute at most, and at once the first time", () => {
    expect(duePing(null, 1_000)).toBe(true);
    expect(duePing(1_000, 1_000 + PRESENCE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(duePing(1_000, 1_000 + PRESENCE_MIN_INTERVAL_MS)).toBe(true);
  });

  it("reads only a well-formed open target from the answer", () => {
    expect(openTarget({ ok: true, returned: true, open: { botId: "chief", threadId: "t1" } })).toEqual({ botId: "chief", threadId: "t1" });
    expect(openTarget({ ok: true, returned: false })).toBeNull();
    expect(openTarget({ ok: true, returned: true, open: { botId: 5, threadId: "t1" } })).toBeNull();
    expect(openTarget(null)).toBeNull();
    expect(openTarget("nope")).toBeNull();
  });
});
