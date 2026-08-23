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
  it("uses the active locale when dictation ends", async () => {
    const { dictationError } = await import("./desktop");
    const translator = { current: (source: string) => source };

    translator.current = (source) => source === "Dictation is only available on macOS for now."
      ? "听写功能目前仅支持 macOS。"
      : source;

    expect(dictationError(2, translator.current)).toBe("听写功能目前仅支持 macOS。");
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
