import { describe, expect, it } from "vitest";

import { callCapabilityHelp } from "@/lib/call-capability";

function capabilities(dictation: DesktopCapabilities["dictation"]): DesktopCapabilities {
  return {
    host: {
      platform: "darwin",
      label: "macOS",
      session: "unknown",
      packaged: true,
    },
    windowChrome: "mac-inset",
    screenPreview: { available: true, interaction: "direct" },
    dictation,
    localComputer: {
      available: true,
      support: "supported",
      enabled: true,
      status: "ready",
    },
  };
}

describe("call capability guidance", () => {
  it("keeps a local Mac call available when the native speech service exists", () => {
    expect(callCapabilityHelp(capabilities({
      available: true,
      engine: "apple-speech",
      onDevice: true,
    }), true)).toBeNull();
  });

  it("sends a hosted workspace view to the native workspace menu", () => {
    expect(callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "remote-server",
    }), false)).toEqual({
      label: "Calls are available on This computer",
      reason: "You're viewing a hosted workspace. Calls use the microphone and on-device speech recognition on your Mac.",
      action: "choose-local-workspace",
    });
  });

  it("tells a browser user to open the installed macOS app", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "desktop-app-required",
    }), false);
    expect(help?.label).toBe("Calls need the macOS desktop app");
    expect(help).not.toHaveProperty("action");
  });

  it("explains that native calls are not supported on a non-Mac desktop", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "unsupported-platform",
    }), false);
    expect(help?.label).toBe("Calls currently need macOS");
    expect(help).not.toHaveProperty("action");
  });

  it("distinguishes a broken local speech service from an unsupported device", () => {
    expect(callCapabilityHelp(capabilities({
      available: true,
      engine: "apple-speech",
      onDevice: true,
    }), false)).toEqual({
      label: "The call service is unavailable",
      reason: "The speech service is unavailable in this app build. Restart or update OpenMausBot.",
    });
  });
});
