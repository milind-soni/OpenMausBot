import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardUnsentUpload, releaseAttachmentImagePreview } from "./composer-attachments";
import { getDraftAttachments, setDraftAttachments } from "./drafts";
import { uploadDraftImage } from "./composer-uploads";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const draftId = "bot:upload:thread";
let store: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal("localStorage", store);
});

afterEach(() => {
  for (const attachment of getDraftAttachments(store, draftId)) {
    if (attachment.kind === "image") releaseAttachmentImagePreview(attachment);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pendingUpload() {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      started.resolve();
      return response.promise;
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  const file = new File(["image bytes"], "photo.png", { type: "image/png" });
  const uploading = uploadDraftImage(draftId, file);
  const path = "/private/attachments/abc12345-1111-2222-3333-abcdef123456.png";
  return {
    started: started.promise,
    uploading,
    fetchMock,
    path,
    finish: () => response.resolve(Response.json({ path, mime: file.type, bytes: file.size })),
    refuse: () => response.resolve(Response.json({ error: "upload refused" }, { status: 413 })),
  };
}

describe("draft image uploads", () => {
  it("discards a completed upload removed while its preview was still uploading", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const pending = pendingUpload();
    await pending.started;
    const image = getDraftAttachments(store, draftId)[0]!;
    expect(image).toMatchObject({ kind: "image", uploading: true, path: "" });
    if (image.kind !== "image") throw new Error("expected pending image");
    releaseAttachmentImagePreview(image);
    discardUnsentUpload(image);
    setDraftAttachments(store, draftId, []);
    expect(pending.fetchMock).toHaveBeenCalledTimes(1);

    pending.finish();
    await pending.uploading;

    expect(getDraftAttachments(store, draftId)).toEqual([]);
    expect(pending.fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([
      ["/api/attachments/abc12345-1111-2222-3333-abcdef123456.png", { method: "DELETE" }],
    ]);
    expect(revoke).toHaveBeenCalledWith(image.previewUrl);
  });

  it("keeps the uploaded file in its original draft when another draft is opened", async () => {
    const pending = pendingUpload();
    await pending.started;
    expect(getDraftAttachments(store, "bot:other:thread")).toEqual([]);

    pending.finish();
    await pending.uploading;

    expect(getDraftAttachments(store, draftId)).toEqual([
      expect.objectContaining({ kind: "image", path: pending.path, name: "photo.png" }),
    ]);
    expect(getDraftAttachments(store, draftId)[0]).not.toHaveProperty("uploading");
    expect(getDraftAttachments(store, "bot:other:thread")).toEqual([]);
    expect(pending.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a newer attachment when the removed upload finishes", async () => {
    const pending = pendingUpload();
    await pending.started;
    const replacement = { kind: "file" as const, id: "new-file", path: "/private/attachments/notes.txt", name: "notes.txt", size: 10 };
    setDraftAttachments(store, draftId, [replacement]);

    pending.finish();
    await pending.uploading;

    expect(getDraftAttachments(store, draftId)).toEqual([replacement]);
    expect(pending.fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([
      ["/api/attachments/abc12345-1111-2222-3333-abcdef123456.png", { method: "DELETE" }],
    ]);
  });

  it("does not request deletion when a removed upload fails without a saved file", async () => {
    const pending = pendingUpload();
    await pending.started;
    setDraftAttachments(store, draftId, []);

    pending.refuse();
    await expect(pending.uploading).rejects.toThrow("upload refused");

    expect(getDraftAttachments(store, draftId)).toEqual([]);
    expect(pending.fetchMock).toHaveBeenCalledTimes(1);
  });
});
