import { describe, expect, it } from "vitest";

import { archiveBlockedReason } from "./bot-archive";

describe("archiveBlockedReason", () => {
  it("blocks archiving the Chief of Staff", () => {
    expect(archiveBlockedReason({ chiefOfStaff: true }, 4)).toBe("Choose another Chief of Staff first");
  });

  it("blocks archiving the last active bot", () => {
    expect(archiveBlockedReason({}, 1)).toBe("Keep at least one active bot");
    expect(archiveBlockedReason({}, 0)).toBe("Keep at least one active bot");
  });

  it("allows archiving any other active bot", () => {
    expect(archiveBlockedReason({}, 2)).toBeUndefined();
    expect(archiveBlockedReason({ chiefOfStaff: false }, 3)).toBeUndefined();
  });
});
