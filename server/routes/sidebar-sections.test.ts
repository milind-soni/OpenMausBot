import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import { Store } from "../store.ts";
import { storeRefusal } from "./sidebar-sections.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("a department refusal the store words", () => {
  it("carries its key, with the store's English unchanged", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    store.createBot({ name: "Scout", section: "Delivery" });
    const missing = store.deleteSection("Nowhere")!;
    expect(storeRefusal(store.renameSection("Nowhere", "Elsewhere")!)).toEqual(storeRefusal(missing));
    const badName = store.renameSection("Delivery", "Bad\u0001name")!;
    expect(storeRefusal(missing)).toEqual({ error: "No such department", errorKey: "serverError.department.notFound" });
    expect(storeRefusal(badName)).toEqual({
      error: "Department name must be 1 to 60 characters without control characters", errorKey: "serverError.department.nameRule",
    });
  });

  it("stays plain English when the app has no words for it", () => {
    expect(storeRefusal("A team with that name already exists")).toEqual({ error: "A team with that name already exists" });
  });
});
