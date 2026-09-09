import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

import { searchPath, tailscaleCandidates } from "../src/listener.ts";

describe("tailscaleCandidates", () => {
  it("includes the standard Windows install locations", () => {
    const candidates = tailscaleCandidates("/home/test");
    expect(candidates).toContain("C:\\Program Files\\Tailscale\\tailscale.exe");
    expect(candidates).toContain("C:\\Program Files (x86)\\Tailscale\\tailscale.exe");
  });

  it("keeps the absolute candidates in documented lookup order with bare PATH last", () => {
    const home = "/home/test";
    expect(tailscaleCandidates(home)).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      join(home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"),
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
      "/run/current-system/sw/bin/tailscale",
      "C:\\Program Files\\Tailscale\\tailscale.exe",
      "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
      "tailscale",
    ]);
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
      if (before === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = before;
      }
    }
  });
});
