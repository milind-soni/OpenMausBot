import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./copy-text";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the clipboard API when it succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the clipboard API rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const field = {
      value: "",
      setAttribute: vi.fn(),
      style: { position: "", left: "" },
      select: vi.fn(),
      remove: vi.fn(),
    };
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("document", {
      createElement: () => field,
      body: { appendChild: vi.fn() },
      execCommand,
    });
    await expect(copyText("fallback")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(field.value).toBe("fallback");
  });
});
