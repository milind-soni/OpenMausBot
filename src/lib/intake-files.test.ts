import { describe, expect, it } from "vitest";

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
