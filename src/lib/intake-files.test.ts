import { describe, expect, it, vi } from "vitest";

import { TURN_IMAGE_MAX_BYTES as SERVER_TURN_IMAGE_MAX_BYTES, TURN_IMAGE_MAX_COUNT as SERVER_TURN_IMAGE_MAX_COUNT } from "../../server/turn-images";
import { composeMessage, fitImagesToSlots, IMAGE_MAX_BYTES, imageBytesLeft, imageSlotsLeft, imagesThatFit, intakeFiles, TURN_IMAGE_MAX_BYTES, TURN_IMAGE_MAX_COUNT, type Attachment } from "./composer-attachments";

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

describe("composer video uploads", () => {
  it.each([
    ["clip.mp4", "video/mp4", "video/mp4"],
    ["clip.MP4", "", "video/mp4"],
    ["clip.dat", "video/mp4; codecs=avc1", "video/mp4"],
    ["recording.webm", "video/webm", "video/webm"],
    ["recording.WEBM", "", "video/webm"],
    ["phone.mov", "video/quicktime", "video/quicktime"],
    ["phone.MOV", "application/octet-stream", "video/quicktime"],
    ["voice.webm", "audio/webm", "audio/webm"],
  ])("uploads %s privately as %s without consuming an image slot", async (name, type, mime) => {
    const uploadedPath = "/private/attachments/uploaded.mp4";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      path: uploadedPath, name, bytes: 4,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const getPath = vi.fn(() => "");
    const uploadImage = vi.fn(async () => null);
    const picked = new File([new Uint8Array([1, 2, 3, 4])], name, { type });
    try {
      const out = await intakeFiles([picked], { allowImages: true, imageSlots: 0, getPath, uploadImage });
      expect(out.problems).toEqual([]);
      expect(out.notice).toBeNull();
      expect(out.attachments).toEqual([expect.objectContaining({ kind: "file", name, path: uploadedPath, size: 4 })]);
      expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/files\?/),
        expect.objectContaining({ method: "POST", headers: { "content-type": mime }, body: picked }));
      expect(uploadImage).not.toHaveBeenCalled();
      expect(getPath).not.toHaveBeenCalled();
      expect(composeMessage("Watch this", out.attachments)).toContain(`<attached-file path="${uploadedPath}" name="${name}" />`);
    } finally {
      fetch.mockRestore();
    }
  });

  it("keeps the file size limit for video before any upload", async () => {
    const picked = Object.defineProperty(new File(["clip"], "large.mp4", { type: "video/mp4" }), "size", { value: 100 * 1024 * 1024 + 1 });
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const out = await intakeFiles([picked], { allowImages: true, getPath: () => "", uploadImage: async () => null });
      expect(out.attachments).toEqual([]);
      expect(out.problems).toEqual([{ kind: "too-large", name: "large.mp4", limitMb: 100 }]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([["movie.avi", "video/x-msvideo"], ["movie.mkv", "video/x-matroska"]])("does not widen the upload whitelist to %s", async (name, type) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const out = await intakeFiles([new File(["clip"], name, { type })], { allowImages: true, getPath: () => "", uploadImage: async () => null });
      expect(out.attachments).toEqual([]);
      expect(out.problems).toEqual([{ kind: "unsupported", names: [name] }]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

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
      expect(out.problems).toEqual([]);
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
    expect(out.problems).toEqual([]);
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
    expect(out.problems).toEqual([]);
  });

  it("does not fall back to an arbitrary disk path when a private upload fails", async () => {
    const out = await intakeFiles([file("notes.pdf", "application/pdf")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
      uploadFile: async () => { throw new Error("private store is full"); },
    });

    expect(out.attachments).toEqual([]);
    expect(out.problems).toEqual([{ kind: "upload-failed", name: "notes.pdf", reason: "private store is full" }]);
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
    expect(out.problems).toEqual([{ kind: "unsupported", names: ["ghost.bin"] }]);
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
    expect(out.problems).toEqual([{ kind: "upload-failed", name: "bad.png", reason: "too large" }]);
  });

  it("stops at the images a message can still take and names the rest", async () => {
    const uploadImage = vi.fn(upload);
    const out = await intakeFiles(
      [file("1.png", "image/png"), file("notes.txt", "text/plain"), file("2.png", "image/png"), file("3.png", "image/png")],
      { allowImages: true, getPath: onDisk, uploadImage, imageSlots: 1 },
    );
    expect(out.attachments.map((a) => "name" in a ? a.name : "")).toEqual(["1.png", "notes.txt"]);
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(out.notice).toBe(`A message takes up to ${TURN_IMAGE_MAX_COUNT} images, 40 MB in all. 2.png, 3.png weren't attached.`);
  });

  it("lets an oversized image fail on its own without taking the last slot", async () => {
    const out = await intakeFiles([file("huge.png", "image/png", IMAGE_MAX_BYTES + 1), file("ok.png", "image/png")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: async (f) => {
        if (f.size > IMAGE_MAX_BYTES) throw new Error(`${f.name} exceeds 10 MB`);
        return upload(f);
      },
      imageSlots: 1,
    });
    expect(out.attachments.map((a) => "name" in a ? a.name : "")).toEqual(["ok.png"]);
    expect(out.notice).toBe("huge.png: huge.png exceeds 10 MB");
  });

  it("splits pasted images by the slots left, passing oversized ones through", () => {
    const images = [{ size: 1 }, { size: IMAGE_MAX_BYTES + 1 }, { size: 2 }, { size: 3 }];
    expect(fitImagesToSlots(images, 2)).toEqual({ kept: [images[0], images[1], images[2]], leftOut: [images[3]] });
    expect(fitImagesToSlots(images, 0)).toEqual({ kept: [images[1]], leftOut: [images[0], images[2], images[3]] });
  });

  it("leaves images uncounted when the engine takes them as plain files", async () => {
    const out = await intakeFiles([file("1.png", "image/png"), file("2.png", "image/png")], {
      allowImages: false, getPath: onDisk, uploadImage: upload, uploadFile: async () => null, imageSlots: 0,
    });
    expect(out.attachments).toHaveLength(2);
    expect(out.notice).toBeNull();
  });

  it("explains that an archive needs unzipping instead of calling it unsupported", async () => {
    const out = await intakeFiles([file("아카이브.zip", "application/zip"), file("run.exe", "application/octet-stream")], {
      allowImages: true, getPath: () => "", uploadImage: upload, uploadFile: async () => null,
    });
    expect(out.attachments).toEqual([]);
    expect(out.notice).toBe(
      "Unable to attach run.exe. Choose a supported image, document, audio, or video file. Archives can't be attached: unzip 아카이브.zip and attach the files inside.",
    );
  });

  it("counts the images already in the draft, and names pasted images past the slots left", () => {
    const draft = [{ kind: "image" }, { kind: "file" }, { kind: "image" }] as unknown as Attachment[];
    expect(imageSlotsLeft(draft)).toBe(TURN_IMAGE_MAX_COUNT - 2);
    expect(imageSlotsLeft(Array.from({ length: TURN_IMAGE_MAX_COUNT + 1 }, () => ({ kind: "image" })) as unknown as Attachment[])).toBe(0);
    const notices: string[] = [];
    const pasted = [file("a.png", "image/png"), file("b.png", "image/png"), file("c.png", "image/png")];
    expect(imagesThatFit(pasted, 2, (notice) => notices.push(notice)).map((image) => image.name)).toEqual(["a.png", "b.png"]);
    expect(notices).toEqual([`A message takes up to ${TURN_IMAGE_MAX_COUNT} images, 40 MB in all. c.png wasn't attached.`]);
    expect(imagesThatFit(pasted, 3, (notice) => notices.push(notice))).toHaveLength(3);
    expect(notices).toHaveLength(1);
  });

  it("keeps the image caps in step with the server", () => {
    expect(TURN_IMAGE_MAX_COUNT).toBe(SERVER_TURN_IMAGE_MAX_COUNT);
    expect(TURN_IMAGE_MAX_BYTES).toBe(SERVER_TURN_IMAGE_MAX_BYTES);
  });

  it("stops at the image bytes a message can still take, so large images are never refused at send", async () => {
    const big = IMAGE_MAX_BYTES - 1;
    const draft = [{ kind: "image", size: big }, { kind: "file", size: big }] as unknown as Attachment[];
    expect(imageBytesLeft(draft)).toBe(TURN_IMAGE_MAX_BYTES - big);
    const out = await intakeFiles(Array.from({ length: 5 }, (_, index) => file(`${index + 1}.png`, "image/png", big)), {
      allowImages: true, getPath: onDisk, uploadImage: upload, imageSlots: imageSlotsLeft(draft), imageBytes: imageBytesLeft(draft),
    });
    expect(out.attachments.map((a) => "name" in a ? a.name : "")).toEqual(["1.png", "2.png", "3.png"]);
    expect(out.notice).toBe("A message takes up to 10 images, 40 MB in all. 4.png, 5.png weren't attached.");
    const notices: string[] = [];
    expect(imagesThatFit([file("a.png", "image/png", big)], 9, (notice) => notices.push(notice), big - 1)).toEqual([]);
    expect(notices).toEqual(["A message takes up to 10 images, 40 MB in all. a.png wasn't attached."]);
  });

  it("lets an empty draft take ten images and names the eleventh", () => {
    expect(imageSlotsLeft([])).toBe(10);
    const notices: string[] = [];
    const pasted = Array.from({ length: 11 }, (_, index) => file(`${index + 1}.png`, "image/png"));
    expect(imagesThatFit(pasted, imageSlotsLeft([]), (notice) => notices.push(notice))).toHaveLength(10);
    expect(notices).toEqual(["A message takes up to 10 images, 40 MB in all. 11.png wasn't attached."]);
  });
});
