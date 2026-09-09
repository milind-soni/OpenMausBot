import { describe, expect, it, vi } from "vitest";

import { intakeFiles, type Attachment } from "./composer-attachments";

type Fake = { name: string; size: number; type: string; text: () => Promise<string> };
const file = (name: string, type: string, size = 10): Fake => ({
  name,
  size,
  type,
  text: async () => "contents",
});
const upload = async (f: Fake): Promise<Attachment> => ({
  kind: "image",
  id: `id-${f.name}`,
  name: f.name,
  path: `/api/attachments/${f.name}`,
  size: f.size,
  mime: f.type,
});
const onDisk = (f: Fake) => `/Users/me/${f.name}`;

describe("intakeFiles", () => {
  it("uploads a browser audio drop instead of requiring a Finder path", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      path: "/private/attachments/note.ogg", name: "Voice note.ogg", bytes: 4,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const getPath = vi.fn(() => "");
    try {
      const out = await intakeFiles([new File(["OggS"], "Voice note.opus", { type: "audio/ogg" })], {
        allowImages: true, getPath, uploadImage: async () => null,
      });
      expect(out.attachments).toEqual([expect.objectContaining({ kind: "file", path: "/private/attachments/note.ogg" })]);
      expect(out.notice).toBeNull();
      expect(getPath).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("uploads images and keeps ordinary files as paths", async () => {
    const out = await intakeFiles([file("shot.png", "image/png"), file("notes.txt", "text/plain")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
    });
    expect(out.attachments.map((a) => [a.kind, "name" in a ? a.name : ""])).toEqual([
      ["image", "shot.png"],
      ["file", "notes.txt"],
    ]);
    expect(out.notice).toBeNull();
  });

  it("uses a private uploaded path for supported documents", async () => {
    const out = await intakeFiles([file("notes.pdf", "application/pdf")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
      uploadFile: async (value) => ({
        kind: "file",
        id: "private-file",
        name: value.name,
        path: "/private/attachments/id.pdf",
        size: value.size,
      }),
    });

    expect(out.attachments).toEqual([expect.objectContaining({
      kind: "file",
      name: "notes.pdf",
      path: "/private/attachments/id.pdf",
    })]);
    expect(out.notice).toBeNull();
  });

  it("does not fall back to an arbitrary disk path when a private upload fails", async () => {
    const out = await intakeFiles([file("notes.pdf", "application/pdf")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
      uploadFile: async () => { throw new Error("private store is full"); },
    });

    expect(out.attachments).toEqual([]);
    expect(out.notice).toContain("notes.pdf: private store is full");
  });

  it("treats an image as an ordinary file when the engine cannot read one", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      allowImages: false,
      getPath: onDisk,
      uploadImage: async () => {
        throw new Error("must not upload");
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].kind).toBe("file");
  });

  it("names the files it could not take, rather than dropping them in silence", async () => {
    const out = await intakeFiles([{ ...file("ghost.bin", "application/octet-stream", 999_999_999) }], {
      allowImages: true,
      getPath: () => "",
      uploadImage: upload,
    });
    expect(out.attachments).toHaveLength(0);
    expect(out.notice).toMatch(/ghost\.bin/);
    expect(out.notice).not.toMatch(/Finder|Save it first/);
  });

  it("reports an upload that failed without losing the files that worked", async () => {
    const out = await intakeFiles([file("ok.png", "image/png"), file("bad.png", "image/png")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: async (f) => {
        if (f.name === "bad.png") throw new Error("too large");
        return upload(f);
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.notice).toMatch(/bad\.png: too large/);
  });
});
