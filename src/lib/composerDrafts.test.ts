import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { draftKey, getQueued, loadDraft, saveDraft, setQueued, subscribeQueue, takeReadyQueued } = await import("./composerDrafts");
const empty = { text: "", attachments: [], queued: null };
const file = { id: "a1", name: "notes.txt", mimeType: "text/plain", size: 4, textContent: "hi" };

describe("composer drafts", () => {
  beforeEach(() => store.clear());

  it("keeps each conversation's text separately", () => {
    saveDraft(draftKey({ botId: "a" }), { ...empty, text: "half-written" });
    saveDraft(draftKey({ groupId: "a" }), { ...empty, text: "room note" });
    expect(loadDraft(draftKey({ botId: "a" })).text).toBe("half-written");
    expect(loadDraft(draftKey({ groupId: "a" })).text).toBe("room note");
    expect(loadDraft(draftKey({ botId: "b" }))).toEqual(empty);
  });

  it("persists text but keeps attachments in memory only", () => {
    const key = draftKey({ botId: "c" });
    saveDraft(key, { text: "see file", attachments: [file] });
    expect(store.get("composer-drafts")).not.toContain("notes.txt");
    expect(loadDraft(key)).toMatchObject({ text: "see file", attachments: [file] });
  });

  it("keeps the latest text in memory when storage writes fail", () => {
    const key = draftKey({ botId: "f" });
    saveDraft(key, { text: "old", attachments: [] });
    const setItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      saveDraft(key, { text: "latest", attachments: [] });
      expect(loadDraft(key).text).toBe("latest");
      saveDraft(key, { text: "", attachments: [] });
      expect(loadDraft(key).text).toBe("");
    } finally {
      localStorage.setItem = setItem;
    }
  });

  it("clears a draft once it is emptied (e.g. after sending)", () => {
    const key = draftKey({ botId: "d" });
    saveDraft(key, { text: "x", attachments: [file] });
    saveDraft(key, empty);
    expect(loadDraft(key)).toEqual(empty);
    expect(JSON.parse(store.get("composer-drafts") ?? "{}")).not.toHaveProperty(key);
  });

  it("survives corrupt storage", () => {
    store.set("composer-drafts", "{not json");
    expect(loadDraft(draftKey({ botId: "e" })).text).toBe("");
  });

  it("queues one message per conversation and releases it once the target is ready", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeQueue(() => seen.push(1));
    setQueued({ botId: "q1" }, { text: "first", attachments: [] });
    setQueued({ botId: "q1" }, { text: "replaced", attachments: [] });
    setQueued({ groupId: "r1" }, { text: "room", attachments: [] });
    expect(getQueued(draftKey({ botId: "q1" }))?.text).toBe("replaced");
    expect(loadDraft(draftKey({ groupId: "r1" })).queued?.text).toBe("room");

    const ready = takeReadyQueued((target) => "botId" in target);
    expect(ready).toEqual([{ target: { botId: "q1" }, message: { text: "replaced", attachments: [] } }]);
    expect(getQueued(draftKey({ botId: "q1" }))).toBeNull();
    expect(takeReadyQueued((target) => "botId" in target)).toEqual([]);
    expect(getQueued(draftKey({ groupId: "r1" }))?.text).toBe("room");

    setQueued({ groupId: "r1" }, null);
    expect(getQueued(draftKey({ groupId: "r1" }))).toBeNull();
    expect(seen.length).toBe(5);
    unsubscribe();
  });
});
