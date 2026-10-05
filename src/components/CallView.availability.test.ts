import { describe, expect, it } from "vitest";

import { callCapabilityHelp } from "@/lib/call-capability";

function capabilities(
  dictation: DesktopCapabilities["dictation"],
  platform: DesktopCapabilities["host"]["platform"] = "darwin",
): DesktopCapabilities {
  return {
    host: {
      platform,
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
      reason: "You're viewing a server. Calls use the microphone and on-device speech recognition on your Mac.",
      action: "choose-local-workspace",
    });
  });

  // Only a Mac's own window can take turns. Elsewhere This computer can't
  // either, so the help names no trip there; the Live button is the way on.
  it.each(["win32", "linux"] as const)("sends nobody on %s to This computer, which can't take turns either", (platform) => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "remote-server",
    }, platform), false);
    expect(help).toEqual({
      label: "Calls where you take turns need the Mac app",
      reason: "They listen with on-device speech recognition, which only the Mac app has.",
    });
  });

  // A browser can make Live calls (the button under this help starts one), so
  // the help says only what needs the Mac app: taking turns.
  it("tells a browser user only taking turns needs the Mac app", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "desktop-app-required",
    }, "other"), false);
    expect(help).toEqual({
      label: "Calls where you take turns need the Mac app",
      reason: "They listen with on-device speech recognition, which only the Mac app has.",
    });
  });

  // Live calls work on Windows and Linux: only taking turns needs the Mac.
  it("says only taking turns needs the Mac app on a non-Mac desktop", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "unsupported-platform",
    }, "win32"), false);
    expect(help?.label).toBe("Calls where you take turns need the Mac app");
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
