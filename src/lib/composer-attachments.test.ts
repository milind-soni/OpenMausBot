// composeMessage with images, the image tag round-trip through
// transcript attachment splitting, and the mime gate the composer pastes through.
import { describe, expect, it, vi } from "vitest";

import {
  appendPastedText,
  attachmentBasename,
  attachmentImageUrl,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  documentMime,
  fileAttachment,
  fileAttachmentFromFile,
  handoffAttachmentImagePreview,
  imageAttachmentFromFile,
  isImageFile,
  optimisticImageAttachment,
  releaseAttachmentImagePreview,
  splitTranscriptAttachments,
  type ImageAttachment,
} from "./composer-attachments";

/** Exercises the spacing and empty-draft cases for pasted text insertion. */
function appendPastedTextTests() {
  /** Keeps an existing draft ahead of newly inserted pasted content. */
  function addsPastedContentAfterDraft() {
    expect(appendPastedText("Keep this", "Edit this too")).toBe("Keep this\n\nEdit this too");
  }

  /** Avoids duplicating a separator when the draft already ends with a newline. */
  function preservesExistingTrailingNewline() {
    expect(appendPastedText("Keep this\n", "Edit this too")).toBe("Keep this\nEdit this too");
  }

  /** Inserts pasted content directly when no draft exists yet. */
  function insertsIntoEmptyDraft() {
    expect(appendPastedText("", "Edit this too")).toBe("Edit this too");
  }

  it("adds pasted content after an existing draft", addsPastedContentAfterDraft);
  it("does not add a second separator when the draft ends with a newline", preservesExistingTrailingNewline);
  it("uses the pasted content directly for an empty draft", insertsIntoEmptyDraft);
}

describe("appendPastedText", appendPastedTextTests);

/** Builds a stable image attachment fixture for prompt and preview tests. */
function image(path: string): ImageAttachment {
  return {
    kind: "image",
    id: "i1",
    path,
    name: "shot.png",
    size: 1234,
    mime: "image/png",
  };
}

describe("composeMessage with images", () => {
  it("emits an attached-image tag carrying the server path and display name", () => {
    const prompt = composeMessage("what is this?", [image("/home/u/.openmausbot/attachments/abc.png")]);
    expect(prompt).toBe(
      'what is this?\n\n<attached-image path="/home/u/.openmausbot/attachments/abc.png" name="shot.png" />',
    );
  });

  it("escapes a hostile path the same way file paths are escaped", () => {
    const prompt = composeMessage("", [image('/x/")} onload="evil()')]);
    // every quote is entity-encoded, so the payload can never break out of
    // the attribute — the tag stays one well-formed element
    expect(prompt).toMatch(/<attached-image path="[^"]*" name="shot.png" \/>/);
    expect(prompt).toContain("&quot;");
  });

  it("keeps an escaped display name on file tags", () => {
    const prompt = composeMessage("", [
      fileAttachment('Project & "notes".pdf', "/store/123.pdf", 42),
    ]);
    expect(prompt).toBe(
      '<attached-file path="/store/123.pdf" name="Project &amp; &quot;notes&quot;.pdf" />',
    );
  });
});

describe("splitTranscriptAttachments", () => {
  it("splits tags out of a stored message and returns the paths", () => {
    const stored =
      'look at this\n\n<attached-image path="/a/b/one.png" />\n\n<attached-image path="/a/b/two.jpg" />';
    const { display, images, files } = splitTranscriptAttachments(stored);
    expect(display).toBe("look at this");
    expect(images).toEqual([
      { path: "/a/b/one.png", name: "one.png" },
      { path: "/a/b/two.jpg", name: "two.jpg" },
    ]);
    expect(files).toEqual([]);
  });

  it("unescapes attribute entities so the path round-trips", () => {
    const stored = '<attached-image path="/a/b/&amp;x.png" />';
    const { images } = splitTranscriptAttachments(stored);
    expect(images).toEqual([{ path: "/a/b/&x.png", name: "&x.png" }]);
  });

  it("keeps a safe original image name while accepting legacy unnamed tags", () => {
    const stored =
      '<attached-image path="/store/123.png" name="Holiday &amp; notes.png" />\n' +
      '<attached-image path="/store/456.webp" />';
    expect(splitTranscriptAttachments(stored).images).toEqual([
      { path: "/store/123.png", name: "Holiday & notes.png" },
      { path: "/store/456.webp", name: "456.webp" },
    ]);
  });

  it("hides file tags and uses their safe display names", () => {
    const stored =
      'review these\n\n<attached-file path="/tmp/one.pdf" name="Project &amp; plan.pdf" />\n\n' +
      '<attached-file path="C:\\saved\\generated.txt" name="folder\\notes&#10;final.txt" />';
    const { display, files } = splitTranscriptAttachments(stored);
    expect(display).toBe("review these");
    expect(files).toEqual([
      { path: "/tmp/one.pdf", name: "Project & plan.pdf" },
      { path: "C:\\saved\\generated.txt", name: "notes final.txt" },
    ]);
  });

  it("uses the saved basename for old file tags without a name", () => {
    const { display, files } = splitTranscriptAttachments(
      '<attached-file path="/home/me/.openmausbot/attachments/report.pdf" />',
    );
    expect(display).toBe("");
    expect(files).toEqual([
      { path: "/home/me/.openmausbot/attachments/report.pdf", name: "report.pdf" },
    ]);
  });

  it("marks only private-store UUID attachment names as actionable", () => {
    const privatePath = "/home/me/.openmausbot/attachments/123e4567-e89b-42d3-a456-426614174000.pdf";
    expect(splitTranscriptAttachments(`<attached-file path="${privatePath}" name="Report.pdf" />`).files[0])
      .toMatchObject({ path: privatePath, name: "Report.pdf", private: true });
    expect(splitTranscriptAttachments('<attached-file path="/Users/me/Desktop/report.pdf" />').files[0]?.private)
      .toBeUndefined();
  });

  it("accepts every UUID version supported by the private attachment store", () => {
    const versionEight = "/private/123e4567-e89b-82d3-a456-426614174000.pdf";
    const versionNine = "/private/123e4567-e89b-92d3-a456-426614174000.pdf";
    expect(splitTranscriptAttachments(`<attached-file path="${versionEight}" />`).files[0]?.private).toBe(true);
    expect(splitTranscriptAttachments(`<attached-file path="${versionNine}" />`).files[0]?.private).toBeUndefined();
  });

  it("does not decode unsupported or repeatedly encoded entities", () => {
    const { files } = splitTranscriptAttachments(
      '<attached-file path="/tmp/a.pdf" name="&amp;quot;draft&apos;.pdf" />',
    );
    expect(files[0]?.name).toBe("&quot;draft&apos;.pdf");
  });

  it("leaves malformed attachment tags visible", () => {
    const stored = '<attached-file name="missing-path.pdf" />';
    expect(splitTranscriptAttachments(stored)).toEqual({ display: stored, images: [], files: [] });
  });

  it("leaves inline and non-self-closing attachment examples visible", () => {
    const stored =
      'Example: <attached-file path="/tmp/inline.pdf" />\n' +
      '<attached-image path="/tmp/not-self-closing.png">';
    expect(splitTranscriptAttachments(stored)).toEqual({ display: stored, images: [], files: [] });
  });

  it("recognises only exact unindented standalone transport tags", () => {
    const stored =
      'before\r\n<attached-image path="/tmp/shot.png" name="Screen shot.png" />  \r\n' +
      '<attached-file path="/tmp/brief.pdf" />\r\nafter';
    expect(splitTranscriptAttachments(stored)).toEqual({
      display: "before\r\nafter",
      images: [{ path: "/tmp/shot.png", name: "Screen shot.png" }],
      files: [{ path: "/tmp/brief.pdf", name: "brief.pdf" }],
    });
  });

  it("keeps attachment-looking lines inside backtick and tilde fences", () => {
    const stored = [
      "```xml",
      '<attached-file path="/tmp/backtick.pdf" />',
      "```",
      "~~~",
      '<attached-image path="/tmp/tilde.png" />',
      "~~~~",
      "```unclosed",
      '<attached-file path="/tmp/unclosed.pdf" />',
    ].join("\n");
    expect(splitTranscriptAttachments(stored)).toEqual({ display: stored, images: [], files: [] });
  });

  it("keeps indented attachment-looking lines as code", () => {
    const stored =
      'Code examples:\n    <attached-file path="/tmp/spaces.pdf" />\n' +
      '\t<attached-image path="/tmp/tab.png" />';
    expect(splitTranscriptAttachments(stored)).toEqual({ display: stored, images: [], files: [] });
  });

  it("keeps attachment-looking lines inside multiline HTML comments", () => {
    const stored = [
      "<!-- this is an example",
      '<attached-file path="/tmp/comment.pdf" />',
      "-->",
      '<attached-file path="/tmp/real.pdf" />',
    ].join("\n");
    const parsed = splitTranscriptAttachments(stored);
    expect(parsed.display).toBe([
      "<!-- this is an example",
      '<attached-file path="/tmp/comment.pdf" />',
      "-->",
    ].join("\n"));
    expect(parsed.files).toEqual([{ path: "/tmp/real.pdf", name: "real.pdf" }]);
    expect(parsed.images).toEqual([]);
  });

  it("keeps CommonMark block tags through the next blank line", () => {
    const stored = [
      '<div class="example">',
      '<attached-image path="/tmp/example.png" />',
      "</div>",
      '<attached-image path="/tmp/after-close.png" />',
      "",
      '<attached-image path="/tmp/real.png" />',
    ].join("\n");
    const parsed = splitTranscriptAttachments(stored);
    expect(parsed.display).toBe([
      '<div class="example">',
      '<attached-image path="/tmp/example.png" />',
      "</div>",
      '<attached-image path="/tmp/after-close.png" />',
    ].join("\n"));
    expect(parsed.images).toEqual([{ path: "/tmp/real.png", name: "real.png" }]);
    expect(parsed.files).toEqual([]);
  });

  it("keeps pre blocks through their closing tag even across blank lines", () => {
    const stored = [
      '<pre class="example">',
      '<attached-file path="/tmp/in-pre.md" />',
      "",
      "</pre>",
      '<attached-file path="/tmp/real.md" />',
    ].join("\n");
    const parsed = splitTranscriptAttachments(stored);
    expect(parsed.files).toEqual([{ path: "/tmp/real.md", name: "real.md" }]);
    expect(parsed.display).toContain('<attached-file path="/tmp/in-pre.md" />');
  });

  it("does not end table or nested section blocks at closing tags", () => {
    const stored = [
      "<table>",
      '<attached-file path="/tmp/in-table.csv" />',
      "</table>",
      "",
      '<section aria-label="example">',
      "<div>",
      '<attached-image path="/tmp/in-nested-div.png" />',
      "</div>",
      "</section>",
      '<attached-file path="/tmp/still-html.md" />',
      "",
      '<attached-file path="/tmp/real.md" />',
    ].join("\n");
    const parsed = splitTranscriptAttachments(stored);
    expect(parsed.images).toEqual([]);
    expect(parsed.files).toEqual([{ path: "/tmp/real.md", name: "real.md" }]);
    expect(parsed.display).toContain('<attached-file path="/tmp/in-table.csv" />');
    expect(parsed.display).toContain('<attached-image path="/tmp/in-nested-div.png" />');
    expect(parsed.display).toContain('<attached-file path="/tmp/still-html.md" />');
  });

  it("keeps processing instructions, CDATA, declarations, and generic HTML literal", () => {
    const stored = [
      "<?example",
      '<attached-file path="/tmp/in-pi.md" />',
      "?>",
      "<![CDATA[",
      '<attached-file path="/tmp/in-cdata.md" />',
      "]]>",
      "<!example",
      '<attached-file path="/tmp/in-declaration.md" />',
      ">",
      '<widget data-name="example">',
      '<attached-file path="/tmp/in-generic.md" />',
      "</widget>",
      "",
      '<attached-file path="/tmp/real.md" />',
    ].join("\n");
    const parsed = splitTranscriptAttachments(stored);
    expect(parsed.files).toEqual([{ path: "/tmp/real.md", name: "real.md" }]);
    for (const path of ["in-pi.md", "in-cdata.md", "in-declaration.md", "in-generic.md"]) {
      expect(parsed.display).toContain(path);
    }
  });

  it("keeps attachment-looking lines inside pasted-text blocks", () => {
    const stored = [
      '<pasted-text index="1">',
      '<attached-file path="/tmp/pasted.pdf" />',
      "</pasted-text>",
      '<attached-file path="/tmp/real.pdf" name="Actual.pdf" />',
    ].join("\n");
    const parsed = splitTranscriptAttachments(stored);
    expect(parsed.display).toBe([
      '<pasted-text index="1">',
      '<attached-file path="/tmp/pasted.pdf" />',
      "</pasted-text>",
    ].join("\n"));
    expect(parsed.files).toEqual([{ path: "/tmp/real.pdf", name: "Actual.pdf" }]);
    expect(parsed.images).toEqual([]);
  });

  it("leaves unsupported attributes and attribute order visible", () => {
    const stored = [
      '<attached-file path="/tmp/extra.pdf" extra="yes" />',
      '<attached-file name="First.pdf" path="/tmp/reordered.pdf" />',
      '<attached-file path="/tmp/duplicate.pdf" name="One.pdf" name="Two.pdf" />',
    ].join("\n");
    expect(splitTranscriptAttachments(stored)).toEqual({ display: stored, images: [], files: [] });
  });

  it("leaves plain text and other tags untouched", () => {
    const stored = '<pasted-text index="1">\nhi\n</pasted-text>';
    const { display, images, files } = splitTranscriptAttachments(stored);
    expect(display).toBe(stored);
    expect(images).toEqual([]);
    expect(files).toEqual([]);
  });
});

describe("attachmentBasename", () => {
  it("takes the final path segment on POSIX and Windows separators", () => {
    expect(attachmentBasename("/a/b/c.png")).toBe("c.png");
    expect(attachmentBasename("C:\\a\\b\\c.png")).toBe("c.png");
  });

  it("turns only generated image names into same-origin preview URLs", () => {
    expect(attachmentImageUrl("/a/b/123e4567-e89b-12d3-a456-426614174000.png")).toBe(
      "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png",
    );
    expect(attachmentImageUrl("C:\\a\\b\\photo.webp")).toBe("/api/attachments/photo.webp");
    expect(attachmentImageUrl("https://attacker.example/tracker.png?cookie=1")).toBeNull();
    expect(attachmentImageUrl("/a/b/payload.svg")).toBeNull();
    expect(attachmentImageUrl("/a/b/not%2Fan-image.png")).toBeNull();
  });
});

describe("isImageFile", () => {
  it("accepts the served image mimes and rejects others", () => {
    expect(isImageFile({ type: "image/png", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/jpeg", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/webp", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/svg+xml", size: 10 })).toBe(false);
    expect(isImageFile({ type: "text/plain", size: 10 })).toBe(false);
  });
});

/**
 * Helper to construct a mock clipboard item for DataTransferItemList testing.
 *
 * @param kind - Item kind (e.g. 'file' or 'string').
 * @param type - Item MIME type.
 * @param file - File instance returned by getAsFile, if any.
 * @returns Mock clipboard item object.
 */
function mockClipboardItem(kind: string, type: string, file: File | null = null) {
  /**
   * Returns the mock file or null.
   *
   * @returns Mock file or null.
   */
  function getAsFile() {
    return file;
  }
  return { kind, type, getAsFile };
}

describe("clipboardImageFiles", () => {
  it("returns empty array for empty or null clipboard", () => {
    expect(clipboardImageFiles(null)).toEqual([]);
    expect(clipboardImageFiles(undefined)).toEqual([]);
    expect(clipboardImageFiles({ files: [], items: [] })).toEqual([]);
  });

  it("extracts images from items when available", () => {
    const pngFile = new File([new Uint8Array([1])], "test.png", { type: "image/png" });
    const clipboardData = {
      items: [
        mockClipboardItem("string", "text/plain"),
        mockClipboardItem("file", "image/png", pngFile),
      ],
      files: [],
    };
    expect(clipboardImageFiles(clipboardData)).toEqual([pngFile]);
  });

  it("falls back to files when items has no image files", () => {
    const jpegFile = new File([new Uint8Array([2])], "test.jpg", { type: "image/jpeg" });
    const clipboardData = {
      items: [
        mockClipboardItem("string", "text/plain"),
      ],
      files: [jpegFile],
    };
    expect(clipboardImageFiles(clipboardData)).toEqual([jpegFile]);
  });

  it("ignores non-image files in fallback", () => {
    const txtFile = new File([new Uint8Array([3])], "test.txt", { type: "text/plain" });
    const clipboardData = {
      items: [],
      files: [txtFile],
    };
    expect(clipboardImageFiles(clipboardData)).toEqual([]);
  });

  it("does not duplicate images exposed through both clipboard collections", () => {
    const file = new File(["image"], "shot.png", { type: "image/png" });
    expect(clipboardImageFiles({ items: [mockClipboardItem("file", file.type, file)], files: [file] })).toEqual([file]);
  });

  it("falls back when an image item cannot produce a file", () => {
    const file = new File(["image"], "shot.png", { type: "image/png" });
    expect(clipboardImageFiles({ items: [mockClipboardItem("file", "image/png", null)], files: [file] })).toEqual([file]);
  });

  it("does not accept unsupported image formats or string items", () => {
    const svg = new File(["<svg/>"], "shot.svg", { type: "image/svg+xml" });
    const png = new File(["image"], "shot.png", { type: "image/png" });
    expect(clipboardImageFiles({ items: [mockClipboardItem("file", svg.type, svg), mockClipboardItem("string", png.type, png)], files: [svg] })).toEqual([]);
  });
});

describe("clipboardHasImages", () => {
  it("detects images in items", () => {
    expect(clipboardHasImages({
      items: [{ kind: "file", type: "image/png" }],
      files: [],
    })).toBe(true);
  });

  it("detects images in files", () => {
    expect(clipboardHasImages({
      items: [],
      files: [{ type: "image/jpeg", size: 10 }],
    })).toBe(true);
  });

  it("returns false when no images exist", () => {
    expect(clipboardHasImages(null)).toBe(false);
    expect(clipboardHasImages({
      items: [{ kind: "string", type: "text/plain" }],
      files: [{ type: "text/plain", size: 10 }],
    })).toBe(false);
  });
});

describe("private document intake", () => {
  it("recognises supported documents by declared mime or filename", () => {
    expect(documentMime({ name: "notes.bin", type: "text/markdown; charset=utf-8" })).toBe("text/markdown");
    expect(documentMime({ name: "REPORT.PDF", type: "" })).toBe("application/pdf");
    expect(documentMime({ name: "archive.zip", type: "application/zip" })).toBeNull();
  });

  it("uses the server path and safe name returned by the private store", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      path: "/private/attachments/123.pdf",
      name: "Quarterly plan.pdf",
      bytes: 3,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "Quarterly plan.pdf", { type: "application/pdf" });
      await expect(fileAttachmentFromFile(file)).resolves.toMatchObject({
        kind: "file",
        path: "/private/attachments/123.pdf",
        name: "Quarterly plan.pdf",
        size: 3,
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\/api\/files\?name=Quarterly%20plan\.pdf&uploadId=[0-9a-f-]{36}$/,
        ),
        expect.objectContaining({ method: "POST", body: file }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it("retries a transient document response once with the same upload id", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: "/private/attachments/22222222-2222-4222-8222-222222222222.pdf",
        name: "Report.pdf",
        bytes: 3,
      }), { status: 201, headers: { "content-type": "application/json" } }));
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "Report.pdf", { type: "application/pdf" });
      await expect(fileAttachmentFromFile(file)).resolves.toMatchObject({ name: "Report.pdf", size: 3 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[0]).toBe(fetch.mock.calls[1]?.[0]);
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("private image intake", () => {
  it("creates local pixels immediately and keeps their identity through upload", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:instant-preview");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      path: "/private/attachments/11111111-1111-4111-8111-111111111111.png",
      mime: "image/png",
      bytes: 3,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "setup.png", { type: "image/png" });
      const optimistic = optimisticImageAttachment(file)!;
      expect(optimistic).toMatchObject({
        kind: "image",
        path: "",
        previewUrl: "blob:instant-preview",
        uploading: true,
      });
      const completed = await imageAttachmentFromFile(file, optimistic);
      expect(completed).toMatchObject({
        id: optimistic.id,
        path: "/private/attachments/11111111-1111-4111-8111-111111111111.png",
        previewUrl: "blob:instant-preview",
      });
      expect(completed).not.toHaveProperty("uploading");
      expect(createObjectURL).toHaveBeenCalledWith(file);
    } finally {
      fetch.mockRestore();
      createObjectURL.mockRestore();
    }
  });

  it("hands local pixels to the transcript until the server preview takes over", () => {
    const path = "/private/attachments/22222222-2222-4222-8222-222222222222.png";
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const attachment = { ...image(path), previewUrl: "blob:handoff" };
    try {
      handoffAttachmentImagePreview(path, attachment.previewUrl);
      expect(attachmentImageUrl(path)).toBe("blob:handoff");
      releaseAttachmentImagePreview(attachment);
      expect(attachmentImageUrl(path)).toBe(
        "/api/attachments/22222222-2222-4222-8222-222222222222.png",
      );
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:handoff");
    } finally {
      revokeObjectURL.mockRestore();
    }
  });

  it("retries a lost response with one upload id and canonicalises the display extension", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        path: "/private/attachments/11111111-1111-4111-8111-111111111111.png",
        mime: "image/png",
        bytes: 3,
      }), { status: 201, headers: { "content-type": "application/json" } }));
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "setup.exe", { type: "image/png" });
      await expect(imageAttachmentFromFile(file)).resolves.toMatchObject({
        kind: "image",
        path: "/private/attachments/11111111-1111-4111-8111-111111111111.png",
        name: "setup.png",
        size: 3,
        mime: "image/png",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      const firstUrl = String(fetch.mock.calls[0]?.[0]);
      expect(firstUrl).toMatch(/^\/api\/attachments\?uploadId=[0-9a-f-]{36}$/);
      expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[0]?.[0]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("bounds repeated network failures to one recovery attempt", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    try {
      const file = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });
      await expect(imageAttachmentFromFile(file)).rejects.toThrow("offline");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[0]?.[0]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("rejects inconsistent image metadata instead of surfacing a misleading filename", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      path: "/private/attachments/11111111-1111-4111-8111-111111111111.jpg",
      mime: "image/png",
      bytes: 3,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    try {
      const file = new File([new Uint8Array([1, 2, 3])], "photo.exe", { type: "image/png" });
      await expect(imageAttachmentFromFile(file)).rejects.toThrow("invalid image metadata");
    } finally {
      fetch.mockRestore();
    }
  });
});
