import { afterEach, describe, expect, it, vi } from "vitest";

import { callCapabilityHelp } from "@/lib/call-capability";
import type { ConfigStatus } from "@/state/store";
import type { SttProvider } from "../../shared/stt";

const speechInput = (provider: SttProvider, configured: boolean) =>
  ({ stt: { provider, configured, baseUrl: "", model: "", keyConfigured: false } }) as ConfigStatus;
const pageMicrophone = () => vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => undefined } });
const nativeSpeech = () => vi.stubGlobal("window", { ogb: { speechStart: async () => undefined } });

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
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a local Mac call available when the native speech service exists", () => {
    nativeSpeech();
    expect(callCapabilityHelp(capabilities({
      available: true,
      engine: "apple-speech",
      onDevice: true,
    }), null)).toBeNull();
  });

  it("says where taking turns works on a server's page in the Mac app, with no trip there", () => {
    const help = callCapabilityHelp(capabilities({
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "remote-server",
    }), null);
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
    }, platform), null);
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
    }, "other"), null);
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
    }, "win32"), null);
    expect(help?.label).toBe("Calls where you take turns need the desktop app");
    expect(help).not.toHaveProperty("action");
  });

  it("keeps Take turns off on Windows until a Fish Audio key is saved, and says where to add one", () => {
    const fish = capabilities({ available: true, engine: "fish-audio", onDevice: false }, "win32");
    pageMicrophone();
    expect(callCapabilityHelp(fish, speechInput("auto", false))).toEqual({
      label: "Set up speech input to take turns on calls",
      reason: "Configure Speech input in Settings, or add a Fish Audio key in Settings \u2192 API keys.",
    });
    expect(callCapabilityHelp(fish, speechInput("auto", true))).toBeNull();
  });

  it("lets a browser page take turns through the server's speech input once its microphone is reachable", () => {
    const browser = capabilities({ available: false, engine: "none", onDevice: false, reasonCode: "desktop-app-required" }, "other");
    expect(callCapabilityHelp(browser, speechInput("openai", true))?.label).toBe("Calls where you take turns need the desktop app");
    pageMicrophone();
    expect(callCapabilityHelp(browser, speechInput("openai", true))).toBeNull();
    expect(callCapabilityHelp(browser, speechInput("openai", false))?.label).toBe("Set up speech input to take turns on calls");
  });

  it("distinguishes a broken local speech service from an unsupported device", () => {
    vi.stubGlobal("window", {});
    expect(callCapabilityHelp(capabilities({
      available: true,
      engine: "apple-speech",
      onDevice: true,
    }), null)).toEqual({
      label: "Calls aren't available right now",
      reason: "The speech service is unavailable in this app build. Restart or update MausBot.",
    });
  });
});
