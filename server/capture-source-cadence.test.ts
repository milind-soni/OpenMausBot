import { describe, expect, it } from "vitest";

import {
  CAPTURE_SOURCE_CADENCE_MAX_AGE_MS,
  captureSourceFreshnessPolicy,
} from "./capture-source-cadence.ts";

describe("capture source cadence policy", () => {
  it("keeps fast sources on a 15-minute receipt SLA", () => {
    expect(captureSourceFreshnessPolicy("gmail-account-1")).toEqual({
      cadence: "fast",
      expectedMaxAgeMs: 15 * 60_000,
    });
    expect(captureSourceFreshnessPolicy("gmail").cadence).toBe("fast");
    expect(captureSourceFreshnessPolicy("calendar").cadence).toBe("fast");
    expect(captureSourceFreshnessPolicy("messages").cadence).toBe("fast");
    expect(captureSourceFreshnessPolicy("calendar-account-3").expectedMaxAgeMs).toBe(15 * 60_000);
    expect(captureSourceFreshnessPolicy("plaud").expectedMaxAgeMs).toBe(15 * 60_000);
    expect(captureSourceFreshnessPolicy("google-messages").expectedMaxAgeMs).toBe(15 * 60_000);
  });

  it("allows waking-delta browser and Drive sources to go seven hours", () => {
    expect(captureSourceFreshnessPolicy("drive-account-1")).toEqual({
      cadence: "waking-delta",
      expectedMaxAgeMs: 7 * 60 * 60_000,
    });
    expect(captureSourceFreshnessPolicy("drive").cadence).toBe("waking-delta");
    expect(captureSourceFreshnessPolicy("youtube").cadence).toBe("waking-delta");
    expect(captureSourceFreshnessPolicy("chrome-history").cadence).toBe("waking-delta");
    expect(captureSourceFreshnessPolicy("local-inbox").cadence).toBe("waking-delta");
    expect(captureSourceFreshnessPolicy("ai-chatgpt").expectedMaxAgeMs).toBe(7 * 60 * 60_000);
  });

  it("keeps daily sources fresh for a full day plus recovery margin", () => {
    for (const sourceId of ["github", "mercury", "whoop", "hevy"]) {
      expect(captureSourceFreshnessPolicy(sourceId)).toEqual({
        cadence: "daily",
        expectedMaxAgeMs: 26 * 60 * 60_000,
      });
    }
  });

  it("uses a safe default for unknown sources", () => {
    expect(captureSourceFreshnessPolicy("future-source")).toEqual({
      cadence: "default",
      expectedMaxAgeMs: CAPTURE_SOURCE_CADENCE_MAX_AGE_MS.default,
    });
  });
});
