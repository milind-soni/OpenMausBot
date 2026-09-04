import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";

import { searchPath, tailscaleCandidates } from "../src/listener.ts";

describe("tailscaleCandidates", () => {
  it("includes the standard Windows install locations", () => {
    const candidates = tailscaleCandidates("/home/test");
    expect(candidates).toContain("C:\\Program Files\\Tailscale\\tailscale.exe");
    expect(candidates).toContain("C:\\Program Files (x86)\\Tailscale\\tailscale.exe");
  });

  it("keeps the macOS, Linux and bare-PATH lookups in order", () => {
    const candidates = tailscaleCandidates("/home/test");
    expect(candidates).toContain("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(candidates).toContain("/opt/homebrew/bin/tailscale");
    expect(candidates).toContain("/usr/local/bin/tailscale");
    expect(candidates).toContain("/usr/bin/tailscale");
    expect(candidates).toContain("/run/current-system/sw/bin/tailscale");
    expect(candidates[candidates.length - 1]).toBe("tailscale");
  });
});

describe("searchPath", () => {
  it("joins PATH with fallback directories using the platform delimiter", () => {
    const before = process.env.PATH;
    process.env.PATH = "/my/bin";
    try {
      const result = searchPath();
      expect(result).toBe(
        ["/my/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
      );
      // The join character is the real check: ':' on POSIX, ';' on Windows.
      expect(result).toContain(delimiter);
    } finally {
      process.env.PATH = before;
    }
  });
});
