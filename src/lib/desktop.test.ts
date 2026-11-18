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

describe("the bridge that resets a switch's approval to Ask", () => {
  it("is the desktop's own bridge, except on a paired desktop, where the host takes the switch", async () => {
    const approvals = { setMode: vi.fn() };
    const { askResetBridge } = await import("./desktop");
    vi.stubGlobal("window", { ogb: { approvals } });
    expect(askResetBridge()).toBe(approvals);
    vi.stubGlobal("window", { ogb: { approvals, remoteClient: { active: true } } });
    expect(askResetBridge()).toBeUndefined();
    vi.stubGlobal("window", {});
    expect(askResetBridge()).toBeUndefined();
  });
});

describe("initial desktop capabilities", () => {
  it.each([
    ["darwin", { available: true, engine: "apple-speech", onDevice: true }],
    ["win32", { available: true, engine: "fish-audio", onDevice: false }],
    ["linux", { available: true, engine: "fish-audio", onDevice: false }],
    ["freebsd", { available: false, engine: "none", onDevice: false, reasonCode: "unsupported-platform" }],
  ])("report dictation on %s", async (platform, dictation) => {
    vi.stubGlobal("window", { ogb: { platform } });
    const desktop = await import("./desktop");
    expect(desktop.initialDesktopCapabilities().dictation).toEqual(dictation);
  });

  it("report no dictation in a browser", async () => {
    vi.stubGlobal("window", {});
    const desktop = await import("./desktop");
    expect(desktop.initialDesktopCapabilities().dictation).toMatchObject({ available: false, reasonCode: "desktop-app-required" });
  });
});
