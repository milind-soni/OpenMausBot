import { describe, expect, it } from "vitest";
import { newBotWorksOn, shouldMountLocalComputer } from "./local-routing.ts";

describe("local computer routing", () => {
  it("never lets Linux Auto fall back to the user's desktop", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("requires an explicit local selection and an approval-capable provider on Linux", () => {
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: false,
      }),
    ).toBe(false);
  });

  it("preserves the established macOS Auto fallback", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
  });

  it("never mounts the local desktop for explicit cloud/off or on an unsupported host", () => {
    for (const requested of ["cloud", "off"] as const) {
      expect(
        shouldMountLocalComputer({
          requested,
          hostPlatform: "darwin",
          providerSupportsLocal: true,
        }),
      ).toBe(false);
    }
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "freebsd",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("treats Windows like macOS: explicit selection and Auto both mount", () => {
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "win32",
        providerSupportsLocal: false,
      }),
    ).toBe(false);
  });
});

describe("where a new bot works when nothing names a place", () => {
  it("is This computer on the desktop app on a Mac or a Windows PC, with a model that can use it", () => {
    expect(newBotWorksOn({ desktopApp: true, platform: "win32", providerSupportsLocal: true })).toBe("local");
    expect(newBotWorksOn({ desktopApp: true, platform: "darwin", providerSupportsLocal: true })).toBe("local");
  });

  it("stays Auto on a server or Cloud, on Linux, and for a model that can't use this computer", () => {
    expect(newBotWorksOn({ desktopApp: false, platform: "win32", providerSupportsLocal: true })).toBeUndefined();
    expect(newBotWorksOn({ desktopApp: true, platform: "linux", providerSupportsLocal: true })).toBeUndefined();
    expect(newBotWorksOn({ desktopApp: true, platform: "darwin", providerSupportsLocal: false })).toBeUndefined();
  });
});
