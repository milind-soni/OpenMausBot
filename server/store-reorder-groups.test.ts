import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("reordering rooms", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("leaves the rooms as they were when the new order cannot be saved", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Ada" });
    for (const name of ["One", "Two", "Three"]) store.createGroup(name, [bot.id]);
    const before = store.groups.map((group) => group.id), wanted = [...before].reverse();
    const file = (store as unknown as { groupsFile: { write: (text: string) => void } }).groupsFile;
    const write = vi.spyOn(file, "write").mockImplementation(() => { throw new Error("disk full"); });
    try {
      expect(() => store.reorderGroups(wanted)).toThrow("disk full");
      expect(store.groups.map((group) => group.id)).toEqual(before);
    } finally {
      write.mockRestore();
    }
    expect(store.reorderGroups(wanted)?.map((group) => group.id)).toEqual(wanted);
  });
});
