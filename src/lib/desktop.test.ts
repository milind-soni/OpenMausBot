import { afterEach, describe, expect, it, vi } from "vitest";

function capabilities(status: "checking" | "ready"): DesktopCapabilities {
  return {
    host: {
      platform: "linux",
      label: "Ubuntu",
      session: "x11",
      packaged: true,
    },
    windowChrome: "native",
    screenPreview: {
      available: true,
      interaction: "direct",
    },
    dictation: {
      available: false,
      engine: "none",
      onDevice: false,
      reasonCode: "unsupported-platform",
    },
    localComputer: {
      available: status === "ready",
      support: "limited",
      enabled: true,
      status,
      reasonCode: status === "checking" ? "checking-driver" : undefined,
    },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("desktop capability cache", () => {
  it("guesses a Whisper microphone on Windows and Linux, and Apple speech on macOS", async () => {
    vi.stubGlobal("window", { ogb: { platform: "win32", arch: "x64" } });
    const windows = await import("./desktop");
    expect(windows.initialDesktopCapabilities().dictation).toMatchObject({
      available: false,
      whisper: true,
      reasonCode: "unsupported-platform",
    });
    vi.resetModules();
    vi.stubGlobal("window", { ogb: { platform: "darwin", arch: "arm64" } });
    const mac = await import("./desktop");
    expect(mac.initialDesktopCapabilities().dictation).toMatchObject({
      available: true,
      engine: "apple-speech",
      whisper: false,
    });
    vi.resetModules();
    vi.stubGlobal("window", { ogb: { platform: "win32", arch: "x64", remoteClient: { active: true } } });
    const remote = await import("./desktop");
    expect(remote.initialDesktopCapabilities().dictation.whisper).toBe(false);
  });

  it("does not let an older initial query replace a newer IPC update", async () => {
    let resolveInitial!: (value: DesktopCapabilities) => void;
    const initial = new Promise<DesktopCapabilities>((resolve) => {
      resolveInitial = resolve;
    });
    vi.stubGlobal("window", {
      ogb: {
        platform: "linux",
        getCapabilities: () => initial,
      },
    });
    const desktop = await import("./desktop");
    const pending = desktop.loadDesktopCapabilities();
    const ready = capabilities("ready");

    desktop.cacheDesktopCapabilities(ready);
    resolveInitial(capabilities("checking"));

    await expect(pending).resolves.toBe(ready);
    await expect(desktop.loadDesktopCapabilities()).resolves.toBe(ready);
  });
});
