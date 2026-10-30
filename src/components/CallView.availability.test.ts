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

  it("says where taking turns works on a server's page in the Mac app, with no trip there", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "remote-server",
    }), false);
    expect(help).toEqual({
      label: "Calls where you take turns work with bots on this Mac",
      reason: "They listen with your Mac's own speech recognition, which only bots on this Mac can use.",
    });
    expect(help).not.toHaveProperty("action");
  });

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
      label: "Calls aren't available right now",
      reason: "The speech service is unavailable in this app build. Restart or update MausBot.",
    });
  });
});
