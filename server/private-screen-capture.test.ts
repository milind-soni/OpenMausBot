import { describe, expect, it, vi } from "vitest";

import { captureOutsideHumanControl } from "./private-screen-capture.ts";

describe("private screen capture", () => {
  it("never starts a capture while a person is driving", async () => {
    const capture = vi.fn(async () => ({ png: "secret", format: "png" }));
    await expect(captureOutsideHumanControl(() => ({ held: true, revision: 1 }), capture)).resolves.toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("drops a capture when control is taken while it is in flight", async () => {
    let state = { held: false, revision: 0 };
    const capture = vi.fn(async () => {
      state = { held: true, revision: 1 };
      return { png: "password-screen", format: "png" };
    });
    await expect(captureOutsideHumanControl(() => state, capture)).resolves.toBeNull();
    expect(capture).toHaveBeenCalledOnce();
  });

  it("drops a frame after a fast take and release during the request", async () => {
    let state = { held: false, revision: 3 };
    const capture = vi.fn(async () => {
      state = { held: true, revision: 4 };
      // The person finished before the remote screenshot response arrived.
      state = { held: false, revision: 5 };
      return { png: "typed-secret", format: "png" };
    });
    await expect(captureOutsideHumanControl(() => state, capture)).resolves.toBeNull();
  });

  it("returns a normalized frame when the whole capture stays private-safe", async () => {
    await expect(captureOutsideHumanControl(
      () => ({ held: false, revision: 7 }),
      async () => ({ png: "ordinary-screen", format: "jpeg" }),
    )).resolves.toEqual({ png: "ordinary-screen", mime: "image/jpeg" });
  });
});
