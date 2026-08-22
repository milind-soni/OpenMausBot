import { describe, expect, it } from "vitest";

import { nextRename } from "./rename";

describe("nextRename", () => {
  it("commits a trimmed new name", () => {
    expect(nextRename("Moss", "  Miso  ")).toBe("Miso");
  });

  it("rejects empty or unchanged drafts", () => {
    expect(nextRename("Moss", "   ")).toBeNull();
    expect(nextRename("Moss", "Moss")).toBeNull();
    expect(nextRename("Moss", " Moss ")).toBeNull();
  });
});
