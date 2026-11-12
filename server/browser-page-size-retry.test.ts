import { describe, expect, it, vi } from "vitest";

import { BROWSER_VIEWPORT, PageSizes } from "./browser-page-size.ts";

describe("page sizing after an unsuccessful attempt", () => {
  it.each(["rejects", "returns false"])("retries before the next bot call when the viewport change %s", async (failure) => {
    const apply = vi.fn().mockResolvedValue(undefined);
    if (failure === "rejects") apply.mockRejectedValueOnce(new Error("browser restarting"));
    else apply.mockResolvedValueOnce(false);
    const sizes = new PageSizes({ apply, lane: (_session, work) => work(), watched: () => true });
    await sizes.resize("s", { width: 1440, height: 900 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(apply).toHaveBeenLastCalledWith("s", { width: 1440, height: 900 });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(await sizes.beforeCall("s")).toBe(false);
  });

  it.each(["rejects", "returns false"])("keeps a pre-call change pending when it %s", async (failure) => {
    const apply = vi.fn().mockResolvedValue(undefined);
    if (failure === "rejects") apply.mockRejectedValueOnce(new Error("browser restarting"));
    else apply.mockResolvedValueOnce(false);
    const sizes = new PageSizes({ apply, lane: (_session, work) => work(), watched: () => false });
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith("s", BROWSER_VIEWPORT);
    expect(await sizes.beforeCall("s")).toBe(false);
  });

  it("stops when the lane wait expires and leaves the change for the next call", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const lane = vi.fn<(session: string, work: () => Promise<void>) => Promise<void | null>>()
      .mockResolvedValueOnce(null).mockImplementation((_session, work) => work());
    const sizes = new PageSizes({ apply, lane, watched: () => true });
    await sizes.resize("s", { width: 1440, height: 900 });
    expect(lane).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(await sizes.beforeCall("s")).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
