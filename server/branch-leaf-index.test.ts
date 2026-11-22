import { afterEach, expect, it } from "vitest";
import { closeMessageDb, importThread, readStoredActiveLeaf } from "./message-db.ts";
import { Store, type Message } from "./store.ts";

afterEach(() => closeMessageDb());

const message = (id: string, parentId: string | null, at: number): Message => ({ id, parentId, at, role: "user", kind: "text", text: id });
const selection = () => ({ instanceId: "fixture", model: "fixture" });

it("chooses the newest child at every branch and persists its final descendant", () => {
  const threadId = "newest-child";
  importThread(threadId, [message("root", null, 1), message("older", "root", 2), message("older-tail", "older", 100), message("newer", "root", 5), message("newer-tail", "newer", 6), message("last-but-older", "root", 3)], "last-but-older");
  const store = new Store(selection);
  const leaves: string[] = [];
  store.onChange((event) => { if (event.type === "thread" && event.activeLeafId) leaves.push(event.activeLeafId); });
  expect(store.setActiveLeaf(threadId, "root")).toBe("newer-tail");
  expect(leaves).toEqual(["newer-tail"]);
  expect(readStoredActiveLeaf(threadId)).toBe("newer-tail");
  closeMessageDb();
  expect(new Store(selection).activeLeaf(threadId)).toBe("newer-tail");
});

it("uses the later stored sibling to break equal timestamps and keeps other roots separate", () => {
  const threadId = "equal-time";
  importThread(threadId, [message("root", null, 1), message("first", "root", 5), message("second", "root", 5), message("other-root", null, 100), message("other-tail", "other-root", 200)], "other-tail");
  const store = new Store(selection);
  expect(store.setActiveLeaf(threadId, "root")).toBe("second");
  expect(store.setActiveLeaf(threadId, "other-root")).toBe("other-tail");
  expect(store.setActiveLeaf(threadId, "missing")).toBeNull();
  expect(readStoredActiveLeaf(threadId)).toBe("other-tail");
});
