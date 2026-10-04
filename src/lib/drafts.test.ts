import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Server rendering never runs effects; keep them so a test can mount and
// unmount a draft hook the way a thread switch does.
const effects = vi.hoisted(() => [] as EffectCallback[]);
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: EffectCallback) => { effects.push(effect); },
}));

import {
  appendComposerDraft,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  draftRevision,
  failedComposerSends,
  getDraft,
  getDraftAttachments,
  getDraftChannelMode,
  isDraftAttachmentPending,
  markDraftEdited,
  prependComposerDraft,
  recoverFailedComposerSend,
  replaceDraftAttachment,
  restoredSendId,
  setDraft,
  setDraftAttachments,
  setDraftChannelMode,
  useComposerChannelMode,
  useDraft,
} from "./drafts";
import { citationAttachment, createCitationTextSelector } from "./citations";
import { composeMessage } from "./composer-attachments";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

// Drafts are also saved when this page loses focus or closes.
const page = vi.hoisted(() => {
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  return page;
});
const leavePage = () => page.dispatchEvent(new Event("pagehide"));
afterAll(() => { vi.unstubAllGlobals(); });

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

function copyStorage(store: Storage): Storage {
  const copy = memoryStorage();
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)!;
    copy.setItem(key, store.getItem(key)!);
  }
  return copy;
}

function renderedChannelMode(id: string): string {
  function Mode() {
    const [mode] = useComposerChannelMode(id);
    return createElement("span", null, mode);
  }
  // A fresh render initializes the actual composer hook from its keyed draft.
  return renderToStaticMarkup(createElement(Mode));
}

describe("channel draft delivery mode", () => {
  it("restores goal intent on remount and from persisted storage after restart", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:goal:task-a";
    setDraft(store, draftId, "Finish the release");
    setDraftChannelMode(store, draftId, "goal");

    expect(renderedChannelMode(draftId)).toBe("<span>goal</span>");
    expect(renderedChannelMode("group:goal:task-b")).toBe("<span>chat</span>");
    expect(renderedChannelMode(draftId)).toBe("<span>goal</span>");

    // A restart closes the page first.
    leavePage();
    const restarted = copyStorage(store);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: restarted });
    expect(renderedChannelMode(draftId)).toBe("<span>goal</span>");
    expect(getDraft(restarted, draftId)).toBe("Finish the release");
  });

  it("keeps legacy drafts intact and defaults missing or invalid modes to chat", () => {
    const store = memoryStorage();
    const draftId = "group:legacy:task";
    store.setItem("omb-drafts", JSON.stringify({ [draftId]: "/goal existing typed goal" }));
    store.setItem("omb-draft-channel-modes", JSON.stringify({ "group:invalid:task": "unexpected" }));
    expect(getDraftChannelMode(store, draftId)).toBe("chat");
    expect(getDraftChannelMode(store, "group:invalid:task")).toBe("chat");
    expect(getDraft(store, draftId)).toBe("/goal existing typed goal");
  });

  it("restores a failed goal send after its original composer unmounted", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:failed-goal:task";
    setDraft(store, draftId, "Finish the release");
    setDraftChannelMode(store, draftId, "goal");
    const sent = {
      draftId,
      revision: draftRevision(draftId),
      sendId: "failed-goal-send",
      threadId: "task",
      text: "Finish the release",
      requestText: "Finish the release",
      attachments: [],
      channelMode: "goal" as const,
    };
    // Send consumes the one-shot mode before its network result arrives.
    setDraft(store, draftId, "");
    setDraftChannelMode(store, draftId, "chat");
    expect(renderedChannelMode(draftId)).toBe("<span>chat</span>");

    expect(recoverFailedComposerSend(sent)).toBe("restored");
    expect(renderedChannelMode(draftId)).toBe("<span>goal</span>");
    expect(getDraft(store, draftId)).toBe(sent.text);
    expect(restoredSendId(draftId)).toBe(sent.sendId);
  });

  it("keeps a newer chat draft when an older goal send fails", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:older-goal:task";
    const revision = draftRevision(draftId);
    markDraftEdited(draftId);
    setDraft(store, draftId, "Just discuss it first");
    setDraftChannelMode(store, draftId, "chat");

    expect(recoverFailedComposerSend({
      draftId,
      revision,
      sendId: "older-goal-send",
      threadId: "task",
      text: "Finish the release",
      requestText: "Finish the release",
      attachments: [],
      channelMode: "goal",
    })).toBe("outbox");
    expect(renderedChannelMode(draftId)).toBe("<span>chat</span>");
    expect(getDraft(store, draftId)).toBe("Just discuss it first");
    expect(failedComposerSends(draftId)).toEqual([
      expect.objectContaining({ channelMode: "goal", sendId: "older-goal-send" }),
    ]);
  });

  it("keeps mode in memory when storage rejects writes and clears it after send", () => {
    const store: Storage = {
      ...memoryStorage(),
      setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:quota-mode:task";
    setDraftChannelMode(store, draftId, "goal");
    expect(renderedChannelMode(draftId)).toBe("<span>goal</span>");
    setDraftChannelMode(store, draftId, "chat");
    expect(renderedChannelMode(draftId)).toBe("<span>chat</span>");
  });
});

describe("durable attachment completion", () => {
  it("isolates persisted citation drafts and keeps an older failed citation send out of a newer draft", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:citations:thread-a";
    const otherDraftId = "bot:citations:thread-b";
    const citation = citationAttachment(
      { ownerType: "bot", ownerId: "citations", threadId: "thread-a", messageId: "source-1" },
      createCitationTextSelector("before selected after", 7, 15)!,
      "old note",
    );
    setDraftAttachments(store, draftId, [citation]);
    expect(getDraftAttachments(store, draftId)).toEqual([citation]);
    expect(getDraftAttachments(store, otherDraftId)).toEqual([]);

    const revision = draftRevision(draftId);
    markDraftEdited(draftId);
    setDraft(store, draftId, "newer words");
    setDraftAttachments(store, draftId, []);
    expect(recoverFailedComposerSend({
      draftId,
      revision,
      sendId: "citation-send",
      threadId: "thread-a",
      text: "",
      requestText: composeMessage("", [citation]),
      attachments: [citation],
    })).toBe("outbox");
    expect(getDraft(store, draftId)).toBe("newer words");
    expect(getDraftAttachments(store, draftId)).toEqual([]);
    expect(failedComposerSends(draftId)).toEqual([expect.objectContaining({ sendId: "citation-send" })]);
  });

  it("keeps blob previews in memory but never writes them into durable storage", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:preview:thread-preview";
    setDraftAttachments(store, draftId, [
      {
        kind: "image",
        id: "uploading",
        path: "",
        name: "uploading.png",
        size: 3,
        mime: "image/png",
        previewUrl: "blob:uploading",
        uploading: true,
      },
      {
        kind: "image",
        id: "ready",
        path: "/private/attachments/ready.png",
        name: "ready.png",
        size: 4,
        mime: "image/png",
        previewUrl: "blob:ready",
      },
    ]);

    expect(getDraftAttachments(store, draftId)).toHaveLength(2);
    expect(JSON.parse(store.getItem("omb-draft-attachments") ?? "{}")[draftId]).toEqual([
      {
        kind: "image",
        id: "ready",
        path: "/private/attachments/ready.png",
        name: "ready.png",
        size: 4,
        mime: "image/png",
      },
    ]);
  });

  it("replaces a pending image after navigation without appending a duplicate", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:replace:thread-replace";
    setDraftAttachments(store, draftId, [{
      kind: "image",
      id: "same-image",
      path: "",
      name: "photo.png",
      size: 3,
      mime: "image/png",
      previewUrl: "blob:photo",
      uploading: true,
    }]);

    expect(replaceDraftAttachment(draftId, "same-image", {
      kind: "image",
      id: "same-image",
      path: "/private/attachments/photo.png",
      name: "photo.png",
      size: 3,
      mime: "image/png",
      previewUrl: "blob:photo",
    })).toBe(true);
    expect(getDraftAttachments(store, draftId)).toEqual([
      expect.objectContaining({ id: "same-image", path: "/private/attachments/photo.png" }),
    ]);
    expect(replaceDraftAttachment(draftId, "missing", null)).toBe(false);
  });

  it("appends to the keyed draft without a mounted React state updater", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    appendDraftAttachments("bot:a:thread-a", [{
      kind: "file",
      id: "file-1",
      path: "/private/attachments/file.pdf",
      name: "file.pdf",
      size: 42,
    }]);
    expect(getDraftAttachments(store, "bot:a:thread-a")).toHaveLength(1);
    expect(getDraftAttachments(store, "bot:b:thread-b")).toEqual([]);
  });

  it("merges with the live in-memory draft when storage rejects writes", () => {
    const readable = memoryStorage();
    const store: Storage = {
      ...readable,
      setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:quota:thread-quota";
    setDraft(store, draftId, "keep this text");
    setDraftAttachments(store, draftId, [{
      kind: "file",
      id: "existing",
      path: "/private/attachments/existing.pdf",
      name: "existing.pdf",
      size: 10,
    }]);

    appendDraftAttachments(draftId, [{
      kind: "file",
      id: "late",
      path: "/private/attachments/late.pdf",
      name: "late.pdf",
      size: 20,
    }]);

    expect(getDraft(store, draftId)).toBe("keep this text");
    expect(getDraftAttachments(store, draftId).map((attachment) => attachment.id))
      .toEqual(["existing", "late"]);
  });

  it("keeps concurrent pending uploads scoped to their originating draft", () => {
    changeDraftAttachmentPending("bot:pending:a", true);
    changeDraftAttachmentPending("bot:pending:a", true);
    changeDraftAttachmentPending("bot:pending:b", true);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(true);
    expect(isDraftAttachmentPending("bot:pending:b")).toBe(true);

    // A completion decrements only one operation; extra completions clamp at
    // zero rather than poisoning a later upload with a negative count.
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:b", false);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(false);
    expect(isDraftAttachmentPending("bot:pending:b")).toBe(false);

    // Starting again after the balanced cleanup remains a fresh pending item.
    changeDraftAttachmentPending("bot:pending:a", true);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(true);
    changeDraftAttachmentPending("bot:pending:a", false);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(false);
  });
});

describe("appendComposerDraft", () => {
  const prompt = "Create a verification skill from the run below.\n\n✓ doctor — pnpm control:omb doctor\n\n";

  it("puts the text into an empty draft exactly as given", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:save:thread-empty";
    const revision = draftRevision(draftId);
    appendComposerDraft(draftId, prompt);
    expect(getDraft(store, draftId)).toBe(prompt);
    leavePage();
    expect(JSON.parse(store.getItem("omb-drafts") ?? "{}")[draftId]).toBe(prompt);
    // an edited draft outranks a late failed send, exactly like typing does
    expect(draftRevision(draftId)).toBe(revision + 1);
  });

  it("appends after a blank line and never replaces what the person typed", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:save:thread-typed";
    setDraft(store, draftId, "Keep the doctor step first.");
    appendComposerDraft(draftId, prompt);
    expect(getDraft(store, draftId)).toBe(`Keep the doctor step first.\n\n${prompt}`);
  });

  it("leaves attachments and the channel mode as they were", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:save:thread-attached";
    const attachment = { kind: "file" as const, id: "file-1", path: "/private/attachments/log.txt", name: "log.txt", size: 12 };
    setDraftAttachments(store, draftId, [attachment]);
    setDraftChannelMode(store, draftId, "goal");
    appendComposerDraft(draftId, prompt);
    expect(getDraft(store, draftId)).toBe(prompt);
    expect(getDraftAttachments(store, draftId)).toEqual([attachment]);
    expect(getDraftChannelMode(store, draftId)).toBe("goal");
  });
});

describe("prependComposerDraft", () => {
  it("puts a queued message into an empty draft and marks it edited", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:edit-queued:empty";
    const revision = draftRevision(draftId);
    prependComposerDraft(draftId, "actually stop at 10");
    expect(getDraft(store, draftId)).toBe("actually stop at 10");
    expect(draftRevision(draftId)).toBe(revision + 1);
  });

  it("leads with the queued words and keeps what the person already typed below", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:edit-queued:typed";
    setDraft(store, draftId, "and use the smaller model");
    prependComposerDraft(draftId, "actually stop at 10");
    expect(getDraft(store, draftId)).toBe("actually stop at 10\n\nand use the smaller model");
  });

  it("treats a whitespace-only draft as empty and leaves attachments alone", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "group:edit-queued:attached";
    const attachment = { kind: "file" as const, id: "file-1", path: "/private/attachments/log.txt", name: "log.txt", size: 12 };
    setDraft(store, draftId, "  \n");
    setDraftAttachments(store, draftId, [attachment]);
    prependComposerDraft(draftId, "check the log");
    expect(getDraft(store, draftId)).toBe("check the log");
    expect(getDraftAttachments(store, draftId)).toEqual([attachment]);
  });
});

describe("saving typed drafts", () => {
  function countedStorage() {
    const store = memoryStorage();
    const writes: string[] = [];
    const counted: Storage = {
      ...store,
      key: store.key,
      get length() { return store.length; },
      setItem: (key, value) => {
        if (key === "omb-drafts") writes.push(value);
        store.setItem(key, value);
      },
    };
    return { store: counted, writes };
  }

  function mountDraft(id: string) {
    effects.length = 0;
    let setText: (next: string) => void = () => {};
    function Draft() {
      [, setText] = useDraft(id);
      return null;
    }
    renderToStaticMarkup(createElement(Draft));
    const cleanups = effects.map((effect) => effect());
    return {
      type: (text: string) => setText(text),
      unmount: () => { for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup(); },
    };
  }

  beforeEach(() => {
    leavePage();
    vi.useFakeTimers();
  });
  afterEach(() => {
    leavePage();
    vi.useRealTimers();
  });

  it("writes storage once when typing pauses, not on every keystroke", () => {
    const { store, writes } = countedStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:typing:thread";
    const composer = mountDraft(draftId);
    let text = "";
    for (let key = 0; key < 20; key += 1) {
      text += "x";
      composer.type(text);
      vi.advanceTimersByTime(100);
    }
    expect(writes).toHaveLength(0);
    // memory answers reads while storage waits
    expect(getDraft(store, draftId)).toBe(text);

    vi.advanceTimersByTime(400);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])[draftId]).toBe(text);
    // a reload reads the last saved draft back from storage
    expect(getDraft(copyStorage(store), draftId)).toBe(text);
    composer.unmount();
  });

  it("saves at once when the window loses focus or the page closes, and only what changed", () => {
    for (const event of ["blur", "pagehide"]) {
      const { store, writes } = countedStorage();
      const draftId = `bot:${event}:thread`;
      setDraft(store, draftId, "half a thought");
      page.dispatchEvent(new Event(event));
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])[draftId]).toBe("half a thought");
      vi.advanceTimersByTime(1_000);
      page.dispatchEvent(new Event(event));
      // nothing typed since, so nothing written again
      expect(writes).toHaveLength(1);
    }
  });

  it("saves at once when the composer switches to another thread", () => {
    const { store, writes } = countedStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const composer = mountDraft("bot:switch:thread-a");
    composer.type("for thread a");
    expect(writes).toHaveLength(0);
    composer.unmount();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])["bot:switch:thread-a"]).toBe("for thread a");
  });

  it("keeps a draft unsaved after a failed write and saves it on the next try", () => {
    const { store, writes } = countedStorage();
    const accepting = store.setItem;
    let full = true;
    store.setItem = (key, value) => {
      if (full) throw new DOMException("quota exceeded", "QuotaExceededError");
      accepting(key, value);
    };
    setDraft(store, "bot:quota-retry:thread", "still on screen");
    leavePage();
    expect(writes).toHaveLength(0);
    full = false;
    page.dispatchEvent(new Event("blur"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])["bot:quota-retry:thread"]).toBe("still on screen");
  });

  it("keeps drafts another window saved and drops an emptied one", () => {
    const { store, writes } = countedStorage();
    store.setItem("omb-drafts", JSON.stringify({ "bot:other-window:thread": "theirs", "bot:sent:thread": "old" }));
    writes.length = 0;
    setDraft(store, "bot:sent:thread", "");
    leavePage();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toEqual({ "bot:other-window:thread": "theirs" });
  });
});
