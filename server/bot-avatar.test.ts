import { describe, expect, it } from "vitest";

import {
  avatarCropRadius,
  botAvatarProfile,
  botAvatarCropSchema,
  botAvatarUrlFromStoredPath,
  botAvatarUrlSchema,
  clampAvatarFocus,
  clampAvatarZoom,
} from "../shared/bot-avatar.ts";

describe("bot avatar profile schema", () => {
  it("accepts the four supported display shapes", () => {
    for (const crop of ["mascot", "circle", "rounded", "square"]) {
      expect(botAvatarCropSchema.parse(crop)).toBe(crop);
    }
    expect(botAvatarCropSchema.safeParse("hexagon").success).toBe(false);
  });

  it("only accepts app-owned raster attachments", () => {
    expect(botAvatarUrlSchema.parse("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp"))
      .toContain("/api/attachments/");
    for (const value of [
      "https://tracker.example/avatar.png",
      "/api/attachments/avatar.svg",
      "/api/attachments/../../config.json",
      "data:image/png;base64,abc",
    ]) {
      expect(botAvatarUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("turns a saved attachment path into a safe serving URL", () => {
    expect(botAvatarUrlFromStoredPath("/tmp/attachments/abc-123.png"))
      .toBe("/api/attachments/abc-123.png");
    expect(botAvatarUrlFromStoredPath("C:\\data\\attachments\\abc-123.jpg"))
      .toBe("/api/attachments/abc-123.jpg");
    expect(botAvatarUrlFromStoredPath("/tmp/attachments/avatar.svg")).toBeNull();
  });

  it("clamps zoom to 1–3 and focus to the picture", () => {
    expect(clampAvatarZoom(2.226)).toBe(2.23);
    expect(clampAvatarZoom(8)).toBe(3);
    expect(clampAvatarZoom("wide")).toBe(1);
    expect(clampAvatarFocus(-0.2)).toBe(0);
    expect(clampAvatarFocus(1.4)).toBe(1);
    expect(clampAvatarFocus(undefined)).toBe(0.5);
  });

  it("uses the photo crop's radius and does not round a mascot", () => {
    expect(avatarCropRadius("circle")).toBe("50%");
    expect(avatarCropRadius("rounded")).toBe("22%");
    expect(avatarCropRadius("square")).toBe("0");
    expect(avatarCropRadius("mascot")).toBe("0");
  });

  it("falls back safely for malformed persisted data", () => {
    expect(botAvatarProfile({ avatarUrl: "https://example.test/pixel.png", avatarCrop: "round" }))
      .toEqual({ avatarCrop: "mascot" });
  });
});
