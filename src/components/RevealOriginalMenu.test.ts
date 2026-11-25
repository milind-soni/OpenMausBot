import { afterEach, describe, expect, it, vi } from "vitest";
import { canRevealOriginal, openLinkedFolder, revealOriginal, revealOriginalLabel } from "./RevealOriginalMenu";

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

describe("a folder link in chat opens the folder in the desktop app", () => {
  it("opens a local folder and says so; a file or a failure keeps the save-a-copy", async () => {
    const open = vi.fn(async (_path: string) => "opened" as "opened" | "not-folder" | "missing" | "invalid" | "failed");
    expect(await openLinkedFolder("/Users/me/Reports", open)).toBe(true);
    expect(open).toHaveBeenCalledWith("/Users/me/Reports");
    for (const answer of ["not-folder", "missing", "invalid", "failed"] as const) {
      open.mockResolvedValueOnce(answer);
      expect(await openLinkedFolder("/Users/me/Reports/q3.pdf", open)).toBe(false);
    }
    open.mockRejectedValueOnce(new Error("ipc"));
    expect(await openLinkedFolder("/Users/me/Reports", open)).toBe(false);
  });

  it("never asks for a relative path or a network share", async () => {
    const open = vi.fn(async () => "opened" as const);
    expect(await openLinkedFolder("Reports", open)).toBe(false);
    expect(await openLinkedFolder("//server/share/Reports", open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("does nothing on the web, a phone or a window connected to another computer", async () => {
    const open = vi.fn(async () => "opened" as const);
    expect(await openLinkedFolder("/Users/me/Reports")).toBe(false);
    vi.stubGlobal("window", { ogb: { openFolder: open, remoteClient: { active: true } } });
    expect(await openLinkedFolder("/Users/me/Reports")).toBe(false);
    expect(open).not.toHaveBeenCalled();
    vi.stubGlobal("window", { ogb: { openFolder: open } });
    expect(await openLinkedFolder("C:\\Users\\me\\Reports")).toBe(true);
  });
});
