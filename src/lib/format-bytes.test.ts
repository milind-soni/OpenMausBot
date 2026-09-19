import { describe, expect, it } from "vitest";

import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("keeps bytes under a KiB whole", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to one decimal at the KiB boundary", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2_048)).toBe("2.0 KB");
  });

  it("switches to MB at the MiB boundary", () => {
    expect(formatBytes(1_048_575)).toBe("1024.0 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(5 * 1_048_576)).toBe("5.0 MB");
  });
});
