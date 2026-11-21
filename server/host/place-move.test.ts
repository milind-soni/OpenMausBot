import { describe, expect, it } from "vitest";

import { changesMachine, createPlaceMoves, placeMoveForBot, placeMoveLine } from "./place-move.ts";

describe("a move between a Cloud and its cloud desktop keeps the files (server/host/place-move.ts)", () => {
  it("Case B: My Cloud to a new cloud desktop tells the bot its files are on My Cloud, not lost, and how to copy one", () => {
    expect(placeMoveForBot({ from: undefined, to: "cloud", home: "my-cloud", fresh: true, folder: "/data/task-workspaces/b1/t1" }))
      .toBe(" The cloud desktop is another machine with its own disk. It is new, so it starts empty. Your files on My Cloud are still there, not lost."
        + " To use a file from My Cloud, copy it there with copy_to_computer (from: a path relative to your working folder, /data/task-workspaces/b1/t1).");
    expect(placeMoveLine({ from: undefined, to: "cloud", home: "my-cloud", fresh: true, bot: "Ledger" }, undefined))
      .toBe("Ledger now works on the cloud desktop, a new one that starts empty. Its files on My Cloud are still there; nothing was lost.");
    expect(placeMoveLine({ from: "browser", to: "cloud", home: "my-cloud", bot: "Ledger" }, undefined))
      .toBe("Ledger now works on the cloud desktop, a different machine from My Cloud. Its files on My Cloud are still there; nothing was lost.");
  });

  it("should-fix 5: a self-hosted VPS gets no copy tools and is never new", () => {
    const text = placeMoveForBot({ from: undefined, to: "cloud", home: "my-cloud", vps: true, fresh: true });
    expect(text).toBe(" The cloud desktop is another machine with its own disk. Your files on My Cloud are still there, not lost.");
    expect(placeMoveLine({ from: undefined, to: "cloud", home: "my-cloud", vps: true, fresh: true, bot: "Ledger" }, undefined)).not.toContain("starts empty");
  });

  it("the reverse says the cloud desktop's files stay there; a team's Cloud is this Cloud", () => {
    expect(placeMoveForBot({ from: "cloud", to: "browser", home: "my-cloud" })).toBe(" My Cloud is another machine with its own disk. Your files on the cloud desktop are still there, not lost. Files you made on the cloud desktop stay there.");
    expect(placeMoveLine({ from: "cloud", to: "browser", home: "team-cloud", bot: "Ledger" }, undefined))
      .toBe("Ledger now works on this Cloud, a different machine from the cloud desktop. Its files on the cloud desktop are still there; nothing was lost.");
  });

  it("should-fix 8: the desktop app says nothing new on any move, and nothing is said where the files stay", () => {
    expect(changesMachine({ from: "local", to: "vm", home: null })).toBe(false);
    expect(changesMachine({ from: undefined, to: "cloud", home: null })).toBe(false);
    expect(placeMoveForBot({ from: "local", to: "vm", home: null })).toBe("");
    expect(placeMoveLine({ from: undefined, to: "vm", home: null, bot: "Ledger" }, undefined)).toBeNull();
    expect(placeMoveForBot({ from: undefined, to: "browser", home: "my-cloud" })).toBe("");
    expect(placeMoveForBot({ from: undefined, to: "cloud", home: "my-cloud" })).not.toContain("starts empty");
  });

  it("writes the person's line only when told the request continued there", () => {
    const notices: string[] = [];
    const moves = createPlaceMoves({ home: "my-cloud", folder: () => "/w", vps: () => false, language: () => undefined, notice: (_threadId, text) => notices.push(text) });
    expect(moves.forBot("b1", "t1", undefined, "cloud", true)).toContain("(from: a path relative to your working folder, /w)");
    expect(notices).toEqual([]);
    moves.continued({ id: "b1", name: "Ledger" }, "t1", undefined, "cloud", true);
    expect(notices).toEqual(["Ledger now works on the cloud desktop, a new one that starts empty. Its files on My Cloud are still there; nothing was lost."]);
  });
});
