import { describe, expect, it } from "vitest";

import {
  browserProfileDeletionBlockReason,
  browserProfilesForPatch,
  browserProfilesMutation,
  newBrowserProfileId,
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

describe("browser profile partition routing", () => {
  const profiles = [
    { id: "client", name: "Client", partitionId: "Client" },
    { id: "personal", name: "Personal" },
  ];

  it("strips internal partition metadata from config PATCH payloads", () => {
    expect(browserProfilesForPatch(profiles)).toEqual([
      { id: "client", name: "Client" },
      { id: "personal", name: "Personal" },
    ]);
  });

  it("carries the My Chrome choice in the payload and in the compare-and-swap base, in the server's key order", () => {
    const mine = [{ id: "mine", name: "Mine", browser: "chrome" as const, partitionId: "Mine" }];
    expect(JSON.stringify(browserProfilesForPatch(mine))).toBe('[{"id":"mine","name":"Mine","browser":"chrome"}]');
    expect(browserProfilesMutation(mine, [{ ...mine[0]!, browser: undefined }])).toEqual({
      browserProfiles: [{ id: "mine", name: "Mine" }],
      expectedBrowserProfiles: [{ id: "mine", name: "Mine", browser: "chrome" }],
    });
  });

  it("sends the exact edited list as a compare-and-swap base without internal metadata", () => {
    const next = [{ ...profiles[0]!, name: "Renamed" }, { id: "new", name: "New" }];
    const mutation = browserProfilesMutation(profiles, next);
    expect(mutation).toEqual({
      expectedBrowserProfiles: [{ id: "client", name: "Client" }, { id: "personal", name: "Personal" }],
      browserProfiles: [{ id: "client", name: "Renamed" }, { id: "new", name: "New" }],
    });
    next[0]!.name = "Later edit";
    expect(mutation.browserProfiles[0]!.name).toBe("Renamed");
    expect(browserProfilesMutation(profiles, []).browserProfiles).toEqual([]);
    expect(browserProfilesMutation([], profiles).expectedBrowserProfiles).toEqual([]);
  });

  it("creates distinct safe profile IDs within the server's 40-character bound", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newBrowserProfileId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^profile-[a-f0-9]{32}$/);
  });
});
