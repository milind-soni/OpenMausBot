import { describe, expect, it } from "vitest";
import { CLOUD_OUTSIDE_KEY, cloudShared, outsideDriven, type SharingEvidence } from "./cloud-sharing.ts";

const OWNER = "p_owner", NOBODY = "p_nobody", DEVICE = "p_device", PHONE = "p_phone", GUEST = "p_guest";
const ownersOrNone = (key: string) => [OWNER, NOBODY, CLOUD_OUTSIDE_KEY, DEVICE].includes(key);
const evidence = (overrides: Partial<SharingEvidence["ownership"]> = {}, rest: Partial<Omit<SharingEvidence, "ownership">> = {}): SharingEvidence => ({
  ownership: { adopted: new Set([PHONE]), proven: new Set([PHONE]), revoked: new Set(), unreadable: false, ...overrides },
  ownersOrNone, recorded: [OWNER, NOBODY, CLOUD_OUTSIDE_KEY, PHONE], ...rest,
});

describe("whether anyone but the owner has used a Cloud home", () => {
  it("is only the owner's while every key on record is the owner's, a device of theirs, proven theirs, or names no person", () => {
    expect(cloudShared(evidence())).toBe(false);
    expect(cloudShared(evidence({}, { seen: [OWNER, PHONE, DEVICE] }))).toBe(false);
  });

  it("is shared for good on any trace of someone else, or when that cannot be known", () => {
    expect(cloudShared(evidence({ sharedSince: 1 }))).toBe(true);
    expect(cloudShared(evidence({ revoked: new Set([GUEST]) }))).toBe(true);
    expect(cloudShared(evidence({ adopted: new Set([PHONE, GUEST]) }))).toBe(true);
    expect(cloudShared(evidence({}, { recorded: [GUEST] }))).toBe(true);
    expect(cloudShared(evidence({}, { seen: [GUEST] }))).toBe(true);
    expect(cloudShared(evidence({ unreadable: true }))).toBe(true);
  });

  it("calls a conversation outside-driven when a webhook started it, posted into it, or drove the work handed to it", () => {
    const records = (overrides: Partial<Parameters<typeof outsideDriven>[1]> = {}) => ({
      webhookRun: (id: string) => id === "hook-run", webhookPosted: (id: string) => id === "updates", handedFrom: () => [] as string[], ...overrides,
    });
    expect(outsideDriven("chat", records())).toBe(false);
    expect(outsideDriven("hook-run", records())).toBe(true);
    expect(outsideDriven("updates", records())).toBe(true);
    expect(outsideDriven("teammate", records({ handedFrom: () => ["chat", "hook-run"] }))).toBe(true);
    expect(outsideDriven("teammate", records({ handedFrom: () => ["chat"] }))).toBe(false);
  });
});
