import { describe, expect, it } from "vitest";
import { shouldMountLocalComputer } from "./local-routing.ts";

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

  it("explicit cloud/off never mounts; explicit local mounts on every desktop platform; auto stays macOS-only", () => {
    for (const requested of ["cloud", "off"] as const) {
      expect(
        shouldMountLocalComputer({
          requested,
          hostPlatform: "darwin",
          providerSupportsLocal: true,
        }),
      ).toBe(false);
    }
    // Explicit "This computer" is opt-in on every platform the bundled
    // cua-driver serves — including Windows now that the driver ships.
    for (const hostPlatform of ["darwin", "linux", "win32"] as const) {
      expect(
        shouldMountLocalComputer({
          requested: "local",
          hostPlatform,
          providerSupportsLocal: true,
        }),
      ).toBe(true);
    }
    // Auto remains conservative: quiet host reachability is macOS-only.
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });
});
