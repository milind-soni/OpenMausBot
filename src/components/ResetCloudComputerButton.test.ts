import { describe, expect, it } from "vitest";
import { cloudComputerResettable, resetNoteKey, type CloudResetView } from "./ResetCloudComputerButton";

const stuck: CloudResetView = {
  computer: "cloud", cloudBackend: "box", canManage: true, busy: false, pending: false,
  phase: "busy-boat", boatState: "starting", refusal: undefined,
};

describe("Reset cloud desktop in the Computer panel", () => {
  it("shows while the cloud computer is stuck starting with no turn running, and when it did not start", () => {
    expect(cloudComputerResettable(stuck)).toBe(true);
    expect(cloudComputerResettable({ ...stuck, boatState: "provisioning" })).toBe(true);
    expect(cloudComputerResettable({ ...stuck, phase: "error", boatState: null, refusal: "cc-no-start" })).toBe(true);
  });

  it("stays hidden while the bot works on it, while the panel is busy, or for a computer that is fine", () => {
    expect(cloudComputerResettable({ ...stuck, busy: true })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, pending: true })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, phase: "ready", boatState: "running" })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, phase: "starting" })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, phase: "cloud-asleep", boatState: "archived" })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, boatState: "archived" })).toBe(false);
  });

  it("is not offered for a refusal a reset cannot fix, or outside the bot's own Cloud computer", () => {
    expect(cloudComputerResettable({ ...stuck, phase: "error", refusal: "cc-no-hours" })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, cloudBackend: "vps" })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, computer: undefined })).toBe(false);
    expect(cloudComputerResettable({ ...stuck, canManage: false })).toBe(false);
  });

  it("says the old cloud desktop is still being deleted when the reset was accepted but not finished", () => {
    expect(resetNoteKey({ ok: true, pending: true })).toBe("computer.reset.pending");
    expect(resetNoteKey({ ok: true })).toBeNull();
    expect(resetNoteKey({ ok: true, missing: true })).toBeNull();
    expect(resetNoteKey(undefined)).toBeNull();
  });
});
