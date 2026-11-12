import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { draftKey, loadDraft, saveDraft } = await import("./composerDrafts");
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

  it("persists text but keeps attachments and queued messages in memory only", () => {
    const key = draftKey({ botId: "c" });
    saveDraft(key, { text: "see file", attachments: [file], queued: { text: "next", attachments: [] } });
    expect(store.get("composer-drafts")).not.toContain("notes.txt");
    expect(loadDraft(key)).toMatchObject({ text: "see file", attachments: [file], queued: { text: "next" } });
  });

  it("clears a draft once it is emptied (e.g. after sending)", () => {
    const key = draftKey({ botId: "d" });
    saveDraft(key, { text: "x", attachments: [file], queued: null });
    saveDraft(key, empty);
    expect(loadDraft(key)).toEqual(empty);
    expect(JSON.parse(store.get("composer-drafts") ?? "{}")).not.toHaveProperty(key);
  });

  it("survives corrupt storage", () => {
    store.set("composer-drafts", "{not json");
    expect(loadDraft(draftKey({ botId: "e" })).text).toBe("");
  });
});
