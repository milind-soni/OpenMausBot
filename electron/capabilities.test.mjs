import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  desktopCapabilities,
  linuxLocalControlSupport,
  linuxSession,
  localComputerReady,
  nativeDesktopActions,
} = require("./capabilities.cjs");
const readyConnection = (mode = "embedded") => ({
  mode, socketPath: "/fixture/cua.sock", mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
});

describe("desktop capabilities", () => {
  it("keeps Apple permissions, Settings, and speech actions unreachable on Linux", () => {
    expect(nativeDesktopActions("linux")).toEqual({
      appleMediaPermissions: false,
      applePrivacySettings: false,
      appleSpeech: false,
    });
    expect(nativeDesktopActions("win32")).toEqual(nativeDesktopActions("linux"));
    expect(nativeDesktopActions("darwin")).toEqual({
      appleMediaPermissions: true,
      applePrivacySettings: true,
      appleSpeech: true,
    });
  });

  it("keeps macOS native features behind a ready CUA connection", () => {
    const capabilities = desktopCapabilities({
      platform: "darwin",
      packaged: true,
      localConnection: readyConnection(),
    });

    expect(capabilities).toMatchObject({
      host: { platform: "darwin", label: "macOS", session: "unknown", packaged: true },
      windowChrome: "mac-inset",
      screenPreview: { available: true, interaction: "direct" },
      dictation: { available: true, engine: "apple-speech", onDevice: true },
      localComputer: { available: true, support: "supported", enabled: true, status: "ready" },
    });
  });

  it("exposes the recorded macOS failure to the local renderer without claiming readiness or leaking it remotely", () => {
    const localConnection = { mode: "unavailable", reason: "Screen Recording required; restart OpenMausBot" };
    const local = desktopCapabilities({ platform: "darwin", localConnection });
    expect(local.localComputer).toMatchObject({
      available: false, enabled: false, status: "unavailable", message: localConnection.reason,
    });
    const remote = desktopCapabilities({ platform: "darwin", localConnection, remote: true });
    expect(remote.localComputer.available).toBe(false);
    expect(remote.localComputer.message).toBe("");
    expect(desktopCapabilities({ platform: "darwin", localConnection: { mode: "unavailable", reason: {} } }).localComputer.message).toBeUndefined();
  });

  it("does not label an incomplete connection ready even when its status claims ready", () => {
    const localComputer = desktopCapabilities({
      platform: "darwin",
      localConnection: { mode: "embedded", status: "ready", enabled: true },
    }).localComputer;
    expect(localComputer).toMatchObject({ available: false, enabled: false, status: "unavailable" });
  });

  it.each(["unavailable", null, {}])("rejects a complete connection with contradictory status %s", (status) => {
    const localComputer = desktopCapabilities({
      platform: "darwin",
      localConnection: { ...readyConnection(), status },
    }).localComputer;
    expect(localComputer).toMatchObject({ available: false, enabled: false, status: "unavailable" });
  });

  it("reports the renderer-caption window chrome on Windows", () => {
    const capabilities = desktopCapabilities({
      platform: "win32",
      env: { DISPLAY: ":0" },
      localConnection: readyConnection(),
    });

    expect(capabilities.windowChrome).toBe("win-caption");
  });

  it("offers Windows local control once the driver is connected", () => {
    const capabilities = desktopCapabilities({
      platform: "win32",
      packaged: true,
      localConnection: readyConnection(),
    });

    expect(capabilities).toMatchObject({
      host: { platform: "win32", label: "Windows", packaged: true },
      localComputer: { available: true, support: "supported", enabled: true, status: "ready" },
    });
  });

  it.each(["unavailable", "standalone"])("keeps Windows local control closed for %s", (mode) => {
    const capabilities = desktopCapabilities({
      platform: "win32",
      packaged: true,
      localConnection: { mode, reason: "no owned driver" },
    });

    expect(capabilities.localComputer).toMatchObject({
      available: false,
      support: "unsupported",
      enabled: false,
      status: "unavailable",
    });
  });

  it.each(["freebsd"])("fails closed on %s", (platform) => {
    const capabilities = desktopCapabilities({
      platform,
      env: { DISPLAY: ":0" },
      localConnection: { mode: "embedded" },
    });

    expect(capabilities.windowChrome).toBe("native");
    expect(capabilities.screenPreview.available).toBe(false);
    expect(capabilities.dictation.available).toBe(false);
    expect(capabilities.localComputer).toMatchObject({
      available: false,
      support: "unsupported",
      reasonCode: "unsupported-platform",
    });
  });

  it("offers direct Xorg preview without enabling local control", () => {
    const capabilities = desktopCapabilities({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      localConnection: { mode: "embedded" },
    });

    expect(capabilities.screenPreview).toEqual({ available: true, interaction: "direct" });
    expect(capabilities.localComputer.available).toBe(false);
  });

  it("offers portal-mediated Wayland preview and fails closed when headless", () => {
    expect(
      desktopCapabilities({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      }).screenPreview,
    ).toEqual({ available: true, interaction: "portal-picker" });
    expect(desktopCapabilities({ platform: "linux", env: {} }).screenPreview).toEqual({
      available: false,
      interaction: "none",
      reasonCode: "headless-session",
    });
  });

  it("detects Wayland before XWayland and distinguishes X11 and headless Linux", () => {
    expect(linuxSession("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland");
    expect(
      linuxSession("linux", {
        XDG_SESSION_TYPE: "x11",
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
      }),
    ).toBe("wayland");
    expect(linuxSession("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe("x11");
    expect(linuxSession("linux", {})).toBe("headless");
  });

  it("re-enables local control only on X11 and keeps Wayland/headless fail-closed", () => {
    expect(
      linuxLocalControlSupport("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }),
    ).toEqual({ available: true, session: "x11" });
    expect(
      linuxLocalControlSupport("linux", {
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
      }),
    ).toMatchObject({
      available: false,
      session: "wayland",
      reasonCode: "linux-wayland-seat-safety-blocked",
    });
    expect(linuxLocalControlSupport("linux", {})).toMatchObject({
      available: false,
      session: "headless",
      reasonCode: "headless-session",
    });
  });

  it("never treats an embedded-looking Linux connection as local control", () => {
    expect(localComputerReady("linux", { mode: "embedded" })).toBe(false);
    expect(localComputerReady("darwin", { mode: "unavailable" })).toBe(false);
    expect(localComputerReady("darwin", readyConnection("standalone"))).toBe(true);
    expect(localComputerReady("darwin", { mode: "embedded" })).toBe(false);
    expect(localComputerReady("darwin", { ...readyConnection(), mcpArgs: [] })).toBe(false);
    expect(localComputerReady("darwin", { ...readyConnection(), mcpArgs: ["other"] })).toBe(false);
  });

  it("enables limited Linux control only for the complete supervised X11 contract", () => {
    const connection = {
      schemaVersion: 1,
      mode: "linux-x11-supervised",
      platform: "linux",
      session: "x11",
      enabled: true,
      status: "ready",
      driver: {
        path: "/home/test/.local/bin/cua-driver",
        version: "0.19.3",
        source: "user-local",
      },
    };
    expect(
      desktopCapabilities({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
        localConnection: connection,
      }).localComputer,
    ).toMatchObject({
      available: true,
      support: "limited",
      enabled: true,
      status: "ready",
      driverVersion: "0.19.3",
      driverSource: "user-local",
    });
    expect(localComputerReady("linux", { ...connection, session: "wayland" })).toBe(false);
    expect(localComputerReady("linux", { ...connection, status: "starting" })).toBe(false);
    expect(localComputerReady("linux", { ...connection, schemaVersion: 2 })).toBe(false);
  });

  it("rejects even a forged ready Wayland contract until its real-seat gate is lifted", () => {
    const connection = {
      schemaVersion: 1,
      mode: "linux-wayland-gnome-supervised",
      platform: "linux",
      session: "wayland",
      compositor: "gnome-mutter",
      enabled: true,
      status: "ready",
    };
    expect(localComputerReady("linux", connection)).toBe(false);
    expect(localComputerReady("linux", { ...connection, compositor: undefined })).toBe(false);
    expect(localComputerReady("linux", { ...connection, session: "x11" })).toBe(false);
    expect(
      desktopCapabilities({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
        localConnection: connection,
      }).localComputer,
    ).toMatchObject({
      available: false,
      support: "unsupported",
      session: "wayland",
      compositor: "gnome-mutter",
    });
  });
});
