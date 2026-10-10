import { describe, expect, it } from "vitest";
import { decodeGeneratedImage } from "./generated-image.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("decodeGeneratedImage", () => {
  it("accepts Codex raw base64 and sniffs the actual raster type", () => {
    const image = decodeGeneratedImage(ONE_PIXEL_PNG);
    expect(image.mime).toBe("image/png");
    expect(image.bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("accepts a raster data URL without trusting its claimed type", () => {
    expect(decodeGeneratedImage(`data:image/jpeg;base64,${ONE_PIXEL_PNG}`).mime).toBe("image/png");
  });

  it("rejects non-image and malformed provider output", () => {
    expect(() => decodeGeneratedImage(Buffer.from("not an image").toString("base64"))).toThrow(/supported raster/);
    expect(() => decodeGeneratedImage("%%%" )).toThrow(/invalid/);
  });
});
