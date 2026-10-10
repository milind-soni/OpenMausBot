import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearReplyDraft,
  discardReplyDraft,
  draftRevision,
  failedComposerSends,
  replyDraft,
  forgetFailedComposerSend,
  getDraft,
  getDraftAttachments,
  markDraftEdited,
  recoverFailedComposerSend,
  rememberReplyDraft,
  restoredSendId,
  selectReplyDraft,
  setDraft,
  setDraftAttachments,
} from "../src/lib/drafts.ts";
import { fileAttachment, pasteAttachment } from "../src/lib/composer-attachments.ts";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("composer drafts", () => {
  it("keeps text and attachments isolated per bot or room", () => {
    const store = memoryStore();
    const paste = pasteAttachment("bot paste");
    const file = fileAttachment("notes.txt", "/tmp/notes.txt", 12);
    setDraft(store, "bot:one", "hello");
    setDraftAttachments(store, "bot:one", [paste, file]);
    setDraft(store, "group:two", "room text");

    expect(getDraft(store, "bot:one")).toBe("hello");
    expect(getDraftAttachments(store, "bot:one")).toEqual([paste, file]);
    expect(getDraft(store, "group:two")).toBe("room text");
    expect(getDraftAttachments(store, "group:two")).toEqual([]);
  });

  it("clears empty entries and ignores malformed stored attachments", () => {
    const store = memoryStore();
    setDraft(store, "bot:one", "hello");
    setDraft(store, "bot:one", "");
    store.setItem(
      "omb-draft-attachments",
      JSON.stringify({ "bot:one": [{ kind: "paste", id: "broken" }] }),
    );

    expect(getDraft(store, "bot:one")).toBe("");
    expect(getDraftAttachments(store, "bot:one")).toEqual([]);
  });

  it("restores a rejected send into its task draft", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    const draftId = "bot:restore:thread-a";
    const attachment = fileAttachment("notes.txt", "/tmp/notes.txt", 12);
    const revision = draftRevision(draftId);

    expect(
      recoverFailedComposerSend({
        draftId,
        revision,
        sendId: "send-restore",
        text: "please retry",
        requestText: "please retry\n\n<attached-file path=\"/tmp/notes.txt\" />",
        attachments: [attachment],
        threadId: "thread-a",
      }),
    ).toBe("restored");
    expect(getDraft(store, draftId)).toBe("please retry");
    expect(getDraftAttachments(store, draftId)).toEqual([attachment]);
    expect(restoredSendId(draftId)).toBe("send-restore");
    markDraftEdited(draftId);
    expect(restoredSendId(draftId)).toBeUndefined();
  });

  it("keeps a failed send in the outbox when a newer draft exists", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    const draftId = "group:preserve:thread-b";
    const revision = draftRevision(draftId);
    markDraftEdited(draftId);
    setDraft(store, draftId, "new draft");

    expect(
      recoverFailedComposerSend({
        draftId,
        revision,
        sendId: "send-preserve",
        text: "older failed send",
        requestText: "older failed send",
        attachments: [],
        replyToId: "message-1",
        threadId: "thread-b",
      }),
    ).toBe("outbox");
    expect(getDraft(store, draftId)).toBe("new draft");
    expect(failedComposerSends(draftId)).toMatchObject([
      {
        text: "older failed send",
        requestText: "older failed send",
        replyToId: "message-1",
        threadId: "thread-b",
      },
    ]);

    const [failed] = failedComposerSends(draftId);
    forgetFailedComposerSend(draftId, failed.id);
    expect(failedComposerSends(draftId)).toEqual([]);
  });

  it("keeps reply targets isolated by task", () => {
    rememberReplyDraft("thread-reply-a", "message-a");
    rememberReplyDraft("thread-reply-b", "message-b");
    expect(replyDraft("thread-reply-a")).toBe("message-a");
    expect(replyDraft("thread-reply-b")).toBe("message-b");
    clearReplyDraft("thread-reply-a");
    expect(replyDraft("thread-reply-a")).toBeUndefined();
    expect(replyDraft("thread-reply-b")).toBe("message-b");
    clearReplyDraft("thread-reply-b");
  });

  it("preserves the original send separately after a reply-only edit", () => {
    const store = memoryStore();
    vi.stubGlobal("localStorage", store);
    const draftId = "bot:reply-edit:thread-c";
    const threadId = "thread-c";
    const revision = draftRevision(draftId);

    selectReplyDraft(draftId, threadId, "new-reply");
    expect(
      recoverFailedComposerSend({
        draftId,
        revision,
        sendId: "send-reply-select",
        text: "reply to the original",
        requestText: "reply to the original",
        attachments: [],
        replyToId: "original-reply",
        threadId,
      }),
    ).toBe("outbox");
    expect(replyDraft(threadId)).toBe("new-reply");
    expect(failedComposerSends(draftId)[0]?.replyToId).toBe("original-reply");

    const nextRevision = draftRevision(draftId);
    discardReplyDraft(draftId, threadId);
    expect(
      recoverFailedComposerSend({
        draftId,
        revision: nextRevision,
        sendId: "send-reply-clear",
        text: "second original",
        requestText: "second original",
        attachments: [],
        replyToId: "another-reply",
        threadId,
      }),
    ).toBe("outbox");
    expect(replyDraft(threadId)).toBeUndefined();

    for (const failed of failedComposerSends(draftId)) {
      forgetFailedComposerSend(draftId, failed.id);
    }
  });
});
