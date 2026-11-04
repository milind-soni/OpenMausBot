import { afterEach, describe, expect, it, vi } from "vitest";
import { canRevealOriginal, revealOriginal, revealOriginalLabel } from "./RevealOriginalMenu";

afterEach(() => vi.unstubAllGlobals());

const shown = vi.fn(async () => "shown" as const);

describe("Show in Finder for the original of a bot's attachment", () => {
  it("is offered only in the desktop app on this computer, for a local absolute path", () => {
    expect(canRevealOriginal("/Users/me/Reports/q3.pdf", shown)).toBe(true);
    expect(canRevealOriginal("C:\\Users\\me\\q3.pdf", shown)).toBe(true);
    expect(canRevealOriginal(undefined, shown)).toBe(false);
    expect(canRevealOriginal("q3.pdf", shown)).toBe(false);
    expect(canRevealOriginal("//server/share/q3.pdf", shown)).toBe(false);
    expect(canRevealOriginal("/Users/me/Reports/q3.pdf", undefined)).toBe(false);
  });

  it("reads the desktop bridge, and a window connected to another computer has none", () => {
    expect(canRevealOriginal("/Users/me/q3.pdf")).toBe(false);
    vi.stubGlobal("window", { ogb: { revealInFolder: shown } });
    expect(canRevealOriginal("/Users/me/q3.pdf")).toBe(true);
    vi.stubGlobal("window", { ogb: { revealInFolder: shown, remoteClient: { active: true } } });
    expect(canRevealOriginal("/Users/me/q3.pdf")).toBe(false);
  });

  it("says Finder on a Mac and folder elsewhere", () => {
    expect(revealOriginalLabel("darwin")).toBe("Show in Finder");
    expect(revealOriginalLabel("win32")).toBe("Show in folder");
    expect(revealOriginalLabel("linux")).toBe("Show in folder");
  });

  it("shows the original, and says so when it moved or is gone instead of falling back to the copy", async () => {
    const reveal = vi.fn(async (_path: string) => "shown" as "shown" | "missing" | "invalid");
    expect(await revealOriginal("/Users/me/q3.pdf", reveal)).toBe("");
    expect(reveal).toHaveBeenCalledWith("/Users/me/q3.pdf");
    reveal.mockResolvedValueOnce("missing");
    expect(await revealOriginal("/Users/me/q3.pdf", reveal)).toBe("The original file was moved or deleted");
    reveal.mockResolvedValueOnce("invalid");
    expect(await revealOriginal("/Users/me/q3.pdf", reveal)).toMatch(/Couldn't show that file/);
    reveal.mockRejectedValueOnce(new Error("ipc"));
    expect(await revealOriginal("/Users/me/q3.pdf", reveal)).toMatch(/Couldn't show that file/);
    expect(reveal).toHaveBeenCalledTimes(4);
  });
});
