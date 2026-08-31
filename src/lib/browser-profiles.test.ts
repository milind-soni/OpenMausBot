import { describe, expect, it } from "vitest";

import {
  browserProfileDeletionBlockReason,
  browserProfileIdFor,
  browserProfilesForPatch,
} from "./browser-profiles";

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

describe("browser profile ids", () => {
  const profiles = [
    { id: "work-microsoft", name: "Work" },
    { id: "work-microsoft-2", name: "Work 2" },
  ];

  it("slugifies a name and steps past taken and reserved ids", () => {
    expect(browserProfileIdFor(" Work / Microsoft ", profiles)).toBe("work-microsoft-3");
    expect(browserProfileIdFor("🔥", profiles)).toBe("profile");
    expect(browserProfileIdFor("Guest", profiles)).toBe("guest-2");
  });

  it("strips internal partition metadata from config PATCH payloads", () => {
    expect(browserProfilesForPatch([
      { id: "client", name: "Client", partitionId: "Client" },
      { id: "personal", name: "Personal" },
    ])).toEqual([
      { id: "client", name: "Client" },
      { id: "personal", name: "Personal" },
    ]);
  });
});
