// composeMessage with images, the image tag round-trip through
// splitAttachedImages, and the mime gate the composer pastes through.
import { describe, expect, it } from "vitest";

import {
  attachmentBasename,
  attachmentImageUrl,
  composeMessage,
  isImageFile,
  splitAttachedImages,
  type ImageAttachment,
} from "./composer-attachments";

const image = (path: string): ImageAttachment => ({
  kind: "image",
  id: "i1",
  path,
  name: "shot.png",
  size: 1234,
  mime: "image/png",
});

describe("composeMessage with images", () => {
  it("emits an attached-image tag carrying the server path", () => {
    const prompt = composeMessage("what is this?", [image("/home/u/.openmausbot/attachments/abc.png")]);
    expect(prompt).toBe(
      'what is this?\n\n<attached-image path="/home/u/.openmausbot/attachments/abc.png" />',
    );
  });

  it("escapes a hostile path the same way file paths are escaped", () => {
    const prompt = composeMessage("", [image('/x/")} onload="evil()')]);
    // every quote is entity-encoded, so the payload can never break out of
    // the attribute — the tag stays one well-formed element
    expect(prompt).toMatch(/<attached-image path="[^"]*" \/>/);
    expect(prompt).toContain("&quot;");
  });
});

describe("splitAttachedImages", () => {
  it("splits tags out of a stored message and returns the paths", () => {
    const stored =
      'look at this\n\n<attached-image path="/a/b/one.png" />\n\n<attached-image path="/a/b/two.jpg" />';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe("look at this");
    expect(images).toEqual(["/a/b/one.png", "/a/b/two.jpg"]);
  });

  it("unescapes attribute entities so the path round-trips", () => {
    const stored = '<attached-image path="/a/b/&amp;x.png" />';
    const { images } = splitAttachedImages(stored);
    expect(images).toEqual(["/a/b/&x.png"]);
  });

  it("leaves plain text and other tags untouched", () => {
    const stored = '<pasted-text index="1">\nhi\n</pasted-text>';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe(stored);
    expect(images).toEqual([]);
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
