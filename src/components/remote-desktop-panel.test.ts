import { describe, expect, it } from "vitest";

import { isActiveTurnRefusal, isRemoteScreenshotContention, remoteScreenshotSource } from "@/lib/remote-desktop";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention";

describe("remote VPS preview", () => {
  it("retries only known transient contention, not permanent 409 failures", () => {
    expect(isRemoteScreenshotContention({ status: 409, message: "this bot's cloud computer is being changed — wait for it to finish" })).toBe(true);
    expect(isRemoteScreenshotContention({ status: 409, message: "the VPS is being prepared — try again shortly" })).toBe(true);
    for (const message of ["VPS is not configured", "The VPS computer is not ready", "Choose Cloud before changing or opening this Box. Auto only checks existing computer state."]) {
      expect(isRemoteScreenshotContention({ status: 409, message })).toBe(false);
    }
    expect(isRemoteScreenshotContention({ status: 503, message: "this bot's cloud computer is being changed — wait for it to finish" })).toBe(false);
  });
  it("recognises the active-turn refusal as a wait, not a fault", () => {
    const message = CLOUD_COMPUTER_BUSY_ERROR;
    expect(isActiveTurnRefusal({ status: 409, message })).toBe(true);
    // api() rejections do not always carry a status
    expect(isActiveTurnRefusal(new Error(message))).toBe(true);
    // server and panel read one constant, so a reword cannot drift them
    // apart; a wrapper around it must still be recognised
    expect(isActiveTurnRefusal({ status: 409, message: `computer: ${message}` })).toBe(true);
    expect(isActiveTurnRefusal({ status: 503, message })).toBe(false);
    expect(isActiveTurnRefusal({ status: 409, message: "this bot's cloud computer is being changed — wait for it to finish" })).toBe(false);
    expect(isActiveTurnRefusal(null)).toBe(false);
  });

  it("accepts only validated screenshot response shapes", () => {
    expect(remoteScreenshotSource({ png: "aGVsbG8=", format: "png" }))
      .toBe("data:image/png;base64,aGVsbG8=");
    expect(remoteScreenshotSource({ png: "aGVsbG8=", format: "jpeg" }))
      .toBe("data:image/jpeg;base64,aGVsbG8=");
  });

  it("rejects malformed formats and payloads", () => {
    expect(remoteScreenshotSource({ png: "<svg onload=alert(1)>", format: "png" })).toBeNull();
    expect(remoteScreenshotSource({ png: "aGVsbG8=", format: "image/svg+xml" })).toBeNull();
    expect(remoteScreenshotSource({ format: "png" })).toBeNull();
    expect(remoteScreenshotSource(null)).toBeNull();
  });
});
