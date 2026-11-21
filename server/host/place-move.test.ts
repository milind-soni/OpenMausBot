import { describe, expect, it } from "vitest";

import { changesMachine, placeMoveForBot, placeMoveLine } from "./place-move.ts";

describe("a move to a place on another machine keeps the files (server/host/place-move.ts)", () => {
  it("Case B: My Cloud to a new cloud computer tells the bot its files are on My Cloud, not lost, and how to copy them", () => {
    const text = placeMoveForBot({ from: undefined, to: "cloud", home: "my-cloud", fresh: true, folder: "/data/task-workspaces/b1/t1" });
    expect(text).toBe(" The cloud computer is a different machine from My Cloud, with its own disk. This cloud computer is new, so it starts empty."
      + " Your earlier files are still on My Cloud and are not lost: never tell the person they are missing, deleted or gone because they are not on the cloud computer."
      + " To use a file from your working folder on My Cloud there, copy it with copy_to_computer: its from is a path relative to your working folder (/data/task-workspaces/b1/t1), never an absolute path; copy_from_computer brings a file back.");
    expect(placeMoveLine({ from: undefined, to: "cloud", home: "my-cloud", fresh: true, bot: "Ledger" }, undefined))
      .toBe("Ledger now works on the cloud computer, a new one that starts empty. Its files on My Cloud are still there; nothing was lost.");
    expect(placeMoveLine({ from: "browser", to: "cloud", home: "my-cloud", bot: "Ledger" }, undefined))
      .toBe("Ledger now works on the cloud computer, a different machine from My Cloud. Its files on My Cloud are still there; nothing was lost.");
  });

  it("on a team's Cloud names this Cloud, never My Cloud", () => {
    expect(placeMoveForBot({ from: undefined, to: "cloud", home: "team-cloud" })).toContain("The cloud computer is a different machine from this Cloud, with its own disk.");
    expect(placeMoveLine({ from: undefined, to: "cloud", home: "team-cloud", bot: "Ledger" }, undefined))
      .toBe("Ledger now works on the cloud computer, a different machine from this Cloud. Its files on this Cloud are still there; nothing was lost.");
  });

  it("the reverse says the cloud computer's files stay there", () => {
    expect(placeMoveForBot({ from: "cloud", to: "browser", home: "my-cloud" })).toContain("My Cloud is a different machine from the cloud computer, with its own disk. Your earlier files are still on the cloud computer and are not lost");
    expect(placeMoveForBot({ from: "cloud", to: "browser", home: "my-cloud" })).toContain("copied into your working folder with copy_from_computer while the cloud computer is the place");
    expect(placeMoveLine({ from: "cloud", to: "browser", home: "my-cloud", bot: "Ledger" }, undefined))
      .toBe("Ledger now works on My Cloud, a different machine from the cloud computer. Its files on the cloud computer are still there; nothing was lost.");
  });

  it("on the desktop app names this computer and the Local VM", () => {
    expect(placeMoveLine({ from: "local", to: "vm", home: "desktop", bot: "Ledger" }, undefined))
      .toBe("Ledger now works on the Local VM, a different machine from this computer. Its files on this computer are still there; nothing was lost.");
    expect(placeMoveForBot({ from: "local", to: "vm", home: "desktop" })).toContain("Nothing moves between them by itself");
  });

  it("says nothing when the files stay where the work goes, and never calls a computer that exists new", () => {
    expect(changesMachine({ from: undefined, to: "browser" })).toBe(false);
    expect(changesMachine({ from: "local", to: "browser" })).toBe(false);
    expect(changesMachine({ from: "cloud", to: "cloud" })).toBe(false);
    expect(placeMoveForBot({ from: undefined, to: "browser", home: "my-cloud" })).toBe("");
    expect(placeMoveLine({ from: "browser", to: "local", home: "desktop", bot: "Ledger" }, undefined)).toBeNull();
    expect(placeMoveForBot({ from: undefined, to: "cloud", home: "my-cloud" })).not.toContain("starts empty");
    expect(placeMoveForBot({ from: "local", to: "vm", home: "desktop", fresh: true }), "only a cloud computer is made by the move").not.toContain("starts empty");
  });
});
