import { describe, expect, it } from "vitest";

import { shortPath } from "./short-path";

describe("shortPath", () => {
  it("shortens home and real children of home", () => {
    expect(shortPath("/Users/ann", "/Users/ann")).toBe("~");
    expect(shortPath("/Users/ann/work", "/Users/ann")).toBe("~/work");
    expect(shortPath("C:\\Users\\ann\\work", "C:\\Users\\ann")).toBe("~\\work");
  });

  it("leaves siblings that merely share a prefix alone", () => {
    expect(shortPath("/Users/annex", "/Users/ann")).toBe("/Users/annex");
  });

  it("passes paths through when home is unknown", () => {
    expect(shortPath("/Users/ann/work", undefined)).toBe("/Users/ann/work");
  });
});
