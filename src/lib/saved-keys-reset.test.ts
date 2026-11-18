import { describe, expect, it } from "vitest";

import { savedKeysUnreadable } from "./saved-keys-reset";

const bridge = (unreadable: () => Promise<boolean>, remoteActive = false) =>
  ({ credentialStore: { unreadable, reset: async () => "cancelled" as const }, remoteClient: { active: remoteActive } }) as unknown as Window["ogb"];

describe("savedKeysUnreadable", () => {
  it("is true only when this app's desktop says its saved keys could not be read", async () => {
    await expect(savedKeysUnreadable(bridge(async () => true))).resolves.toBe(true);
    await expect(savedKeysUnreadable(bridge(async () => false))).resolves.toBe(false);
  });

  it("is false in a browser, on a client of another computer, and when the desktop cannot answer", async () => {
    await expect(savedKeysUnreadable({} as Window["ogb"])).resolves.toBe(false);
    await expect(savedKeysUnreadable(bridge(async () => true, true))).resolves.toBe(false);
    await expect(savedKeysUnreadable(bridge(async () => { throw new Error("no handler"); }))).resolves.toBe(false);
  });
});
