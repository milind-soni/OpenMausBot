import { describe, expect, it } from "vitest";
import { draggedFolder, FOLDER_DRAG_TYPE, moveFolder, placeFolder } from "./folder-order";

describe("folder ordering", () => {
  const ids = ["one", "two", "three"];
  it("moves before and after a row, preserving every folder exactly once", () => {
    expect(placeFolder(ids, "three", "one", "before")).toEqual(["three", "one", "two"]);
    expect(placeFolder(ids, "one", "three", "after")).toEqual(["two", "three", "one"]);
    expect(placeFolder(ids, "three", "one", "after")).toEqual(["one", "three", "two"]);
    expect(ids).toEqual(["one", "two", "three"]);
  });
  it("supports keyboard menu movement and leaves boundaries and stale ids unchanged", () => {
    expect(moveFolder(ids, "two", -1)).toEqual(["two", "one", "three"]);
    expect(moveFolder(ids, "two", 1)).toEqual(["one", "three", "two"]);
    expect(moveFolder(ids, "one", -1)).toEqual(ids);
    expect(moveFolder(ids, "three", 1)).toEqual(ids);
    expect(moveFolder(ids, "missing", 1)).toEqual(ids);
    expect(placeFolder(ids, "one", "one", "after")).toEqual(ids);
    expect(placeFolder(ids, "missing", "one", "after")).toEqual(ids);
    expect(placeFolder(ids, "one", "missing", "before")).toEqual(ids);
  });
  it("accepts only same-bot existing folders and never section/plain-text payloads", () => {
    expect(draggedFolder(JSON.stringify({ botId: "bot", projectId: "two" }), "bot", ids)).toBe("two");
    expect(draggedFolder(JSON.stringify({ botId: "other", projectId: "two" }), "bot", ids)).toBeNull();
    expect(draggedFolder(JSON.stringify({ botId: "bot", projectId: "deleted" }), "bot", ids)).toBeNull();
    for (const raw of ["bots", "two", "{}", "null", "[]", "true"]) expect(draggedFolder(raw, "bot", ids)).toBeNull();
    expect(FOLDER_DRAG_TYPE).not.toBe("application/x-openmausbot-sidebar-section");
  });
});
