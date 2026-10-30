import { describe, expect, it, vi } from "vitest";
import { providerIconFromFile } from "./ProviderIconPicker";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("provider icon upload", () => {
  it("reads and decodes a valid image before returning persistable data", async () => {
    const decode = vi.fn(async () => ({ width: 64, height: 64 }));
    const icon = await providerIconFromFile(new File([png], "custom-diamond.png", { type: "image/png" }), decode);
    if (icon.kind !== "custom") throw new Error("Expected a custom provider icon");
    expect(icon.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(decode).toHaveBeenCalledOnce();
  });

  it("rejects unsupported and undecodable files before save", async () => {
    await expect(providerIconFromFile(new File(["<svg/>"] , "unsupported.svg", { type: "image/svg+xml" }), vi.fn()))
      .rejects.toThrow("PNG, JPEG, or WebP");
    const decode = vi.fn(async () => { throw new Error("OpenMausBot could not decode that image."); });
    await expect(providerIconFromFile(new File([png], "invalid.png", { type: "image/png" }), decode))
      .rejects.toThrow("could not decode");
    expect(decode).toHaveBeenCalledOnce();
  });
});
