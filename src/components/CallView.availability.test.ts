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
    }), true, false)).toBeNull();
  });

  it("says where taking turns works on a server's page in the Mac app, with no trip there", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "remote-server",
    }), false, false);
    expect(help).toEqual({
      label: "Calls where you take turns work with bots on this Mac",
      reason: "They listen with your Mac's own speech recognition, which only bots on this Mac can use.",
    });
    expect(help).not.toHaveProperty("action");
  });

  it.each(["win32", "linux"] as const)("says taking turns works with bots on this computer from a server's page on %s", (platform) => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "remote-server",
    }, platform), false, false);
    expect(help).toEqual({
      label: "Calls where you take turns work with bots on this computer",
      reason: "They listen from this computer's own window, so only bots on this computer can use them.",
    });
  });

  it("tells a browser user only taking turns needs the desktop app", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "desktop-app-required",
    }, "other"), false, false);
    expect(help).toEqual({
      label: "Calls where you take turns need the desktop app",
      reason: "They listen from this computer, so they need MausBot on a Mac, Windows or Linux computer.",
    });
  });

  it("says only taking turns needs the desktop app where the platform has none", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "unsupported-platform",
    }, "win32"), false, false);
    expect(help?.label).toBe("Calls where you take turns need the desktop app");
    expect(help).not.toHaveProperty("action");
  });

  it("keeps Take turns off on Windows until a Fish Audio key is saved, and says where to add one", () => {
    const fish = capabilities({ available: true, engine: "fish-audio", onDevice: false }, "win32");
    expect(callCapabilityHelp(fish, true, false)).toEqual({
      label: "Add a Fish Audio or ElevenLabs key to take turns on calls",
      reason: "On this computer, Take turns hears you through Fish Audio or ElevenLabs speech-to-text. Add either key in Settings → API keys.",
    });
    expect(callCapabilityHelp(fish, true, true)).toBeNull();
  });

  it("distinguishes a broken local speech service from an unsupported device", () => {
    expect(callCapabilityHelp(capabilities({
      available: true,
      engine: "apple-speech",
      onDevice: true,
    }), false, false)).toEqual({
      label: "Calls aren't available right now",
      reason: "The speech service is unavailable in this app build. Restart or update MausBot.",
    });
  });
});
