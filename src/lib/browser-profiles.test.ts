import { describe, expect, it } from "vitest";

import { browserProfileDeletionBlockReason } from "./browser-profiles";

describe("browser profile deletion", () => {
  it("blocks a wipe while any assigned bot has a live turn", () => {
    const bots = [
      { name: "Researcher", browserProfile: "work", busy: true },
      { name: "Writer", browserProfile: "work", busy: false },
      { name: "Personal", browserProfile: "home", busy: true },
    ];
    expect(browserProfileDeletionBlockReason(bots, "work")).toBe(
      "Researcher is still running. Stop that bot before deleting this browser profile.",
    );
    expect(browserProfileDeletionBlockReason(bots, "unused")).toBeNull();
  });
});
