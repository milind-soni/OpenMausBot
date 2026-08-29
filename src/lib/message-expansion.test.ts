import { describe, expect, it } from "vitest";

import {
  isMessageExpanded,
  persistMessageExpansion,
  type MessageExpansionStorage,
} from "./message-expansion";

function memoryStorage(): MessageExpansionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("message expansion persistence", () => {
  it("restores an expanded message after navigation or restart", () => {
    const storage = memoryStorage();

    persistMessageExpansion("thread-1", "message-1", true, storage);

    expect(isMessageExpanded("thread-1", "message-1", storage)).toBe(true);
    expect(isMessageExpanded("thread-1", "message-2", storage)).toBe(false);
  });

  it("restores the collapsed state after Show less", () => {
    const storage = memoryStorage();
    persistMessageExpansion("thread-1", "message-1", true, storage);

    persistMessageExpansion("thread-1", "message-1", false, storage);

    expect(isMessageExpanded("thread-1", "message-1", storage)).toBe(false);
  });

  it("fails closed to collapsed when storage is corrupt or unavailable", () => {
    const corrupt: MessageExpansionStorage = {
      getItem: () => "not-json",
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(isMessageExpanded("thread-1", "message-1", corrupt)).toBe(false);
    expect(() => persistMessageExpansion("thread-1", "message-1", true, corrupt)).not.toThrow();
  });
});
