import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CUA_SDK_SOURCE, CUA_SDK_VERSION, verifyCuaSdkPatch } from "./build-windows-cua-sdk.mjs";
import { verifyAssetBytes } from "./prepare-browser.mjs";

describe("Windows embedded CUA console backport", () => {
  it("pins the SDK's exact release source and single launch-site patch", () => {
    expect(CUA_SDK_VERSION).toBe("0.28.2");
    expect(CUA_SDK_SOURCE.url).toContain("fc188250b4ca8549b8e61f937fdb1fb560770e86");
    const patch = readFileSync(new URL("../third_party/cua/windows-embedded-console.patch", import.meta.url));
    expect(() => verifyCuaSdkPatch(patch)).not.toThrow();
    expect(() => verifyCuaSdkPatch(Buffer.concat([patch, Buffer.from("\n")]))).toThrow(/SHA-256/);
    expect([...patch.toString().matchAll(/^diff --git a\/(\S+) /gm)].map(match => match[1]))
      .toEqual(["libs/cua-driver/rust/crates/cua-driver-sdk/src/embedded.rs"]);
    expect(patch.toString()).toContain("#[cfg(windows)]");
    expect(patch.toString()).toContain("command.creation_flags(0x08000000)");
    expect(() => verifyAssetBytes(Buffer.from("wrong source"), CUA_SDK_SOURCE)).toThrow(/SHA-256/);
  });
});
