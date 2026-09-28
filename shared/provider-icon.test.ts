import { describe, expect, it } from "vitest";
import { PROVIDER_ICON_MAX_BYTES, providerIconError } from "./provider-icon";

describe("provider icon validation", () => {
  it("accepts known presets and bounded raster data", () => {
    expect(providerIconError({ kind: "preset", preset: "openai" })).toBeNull();
    expect(providerIconError({ kind: "custom", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" })).toBeNull();
    expect(providerIconError({ kind: "custom", dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAECP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD60CH//2Q==" })).toBeNull();
    expect(providerIconError({ kind: "custom", dataUrl: "data:image/webp;base64,UklGRjQAAABXRUJQVlA4ICgAAABQAQCdASoDAAIAAgA0JaAABDOAAP7fgD//7B3//nAf/84D+l4HAAAA" })).toBeNull();
    expect(providerIconError({ kind: "custom", dataUrl: "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAfQq+L1v/+BiOh/AAA=" })).toBeNull();
  });

  it("rejects remote URLs, forged media types, and oversized payloads", () => {
    expect(providerIconError({ kind: "custom", dataUrl: "https://example.test/icon.png" })).toContain("PNG");
    expect(providerIconError({ kind: "custom", dataUrl: "data:image/png;base64,/9j/AA==" })).toContain("file type");
    expect(providerIconError({ kind: "custom", dataUrl: "data:image/png;base64,iVBORw0KGgo=" })).toContain("incomplete");
    const oversized = Buffer.alloc(PROVIDER_ICON_MAX_BYTES + 1).toString("base64");
    expect(providerIconError({ kind: "custom", dataUrl: `data:image/jpeg;base64,${oversized}` })).toContain("128 KB");
  });
});
