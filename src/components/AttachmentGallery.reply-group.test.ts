import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { AttachmentGallery, replyAttachmentGroup } from "./AttachmentGallery";

setLocale("en");
const message = { threadId: "t", messageId: "m" };
const deliver = (name: string, path = `/store/${name}`) => ({ kind: "file" as const, path, mime: "text/markdown", name });

describe("files under a reply", () => {
  it("drops a file the text links inline, so it shows once", () => {
    const text = "Updated [DESIGN_SYSTEM.md](/work/DESIGN_SYSTEM.md) and [MEMORY.md](/work/MEMORY.md).";
    expect(replyAttachmentGroup(text, [])).toEqual({ images: [], files: [], delivered: {} });
  });

  it("lets an inline link stand for the same file delivered with attach_file", () => {
    const text = "See [DESIGN_SYSTEM.md](/work/DESIGN_SYSTEM.md).";
    const group = replyAttachmentGroup(text, [deliver("DESIGN_SYSTEM.md"), deliver("report.pdf")]);
    expect(group.delivered).toEqual({ "DESIGN_SYSTEM.md": "/store/DESIGN_SYSTEM.md" });
    expect(group.files.map((file) => file.name)).toEqual(["report.pdf"]);
  });

  it("keeps two deliveries with one name as chips, a link can't pick between them", () => {
    const group = replyAttachmentGroup("[a.md](/work/a.md)", [deliver("a.md", "/store/1"), deliver("a.md", "/store/2")]);
    expect(group.delivered).toEqual({});
    expect(group.files.map((file) => file.path)).toEqual(["/store/1", "/store/2"]);
  });

  it("keeps a player for a linked clip and the delivered images", () => {
    const group = replyAttachmentGroup("Here is [demo.mp4](/work/demo.mp4)", [{ kind: "image", path: "/store/aaaa.png" }]);
    expect(group.images).toEqual(["/store/aaaa.png"]);
    expect(group.files.map((file) => file.name)).toEqual(["demo.mp4"]);
  });
});

describe("the group beneath a reply", () => {
  const files = Array.from({ length: 9 }, (_, index) => ({ path: `/store/f${index}.md`, name: index === 2 ? "أخبار الذكاء الاصطناعي 9 أكتوبر.md" : `file-${index}.md`, private: true }));
  const html = renderToStaticMarkup(createElement(AttachmentGallery, { files, message, beneath: true }));

  it("sits under the text as wrapping 28px pills", () => {
    expect(html).toMatch(/<section[^>]*class="mt-2\.5 /);
    expect(html).toContain("flex max-w-full flex-wrap items-start gap-1.5");
    expect(html).toContain("h-7");
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("min-h-10");
  });

  it("shows six, then +N more", () => {
    expect(html.match(/aria-label="Save a copy of /g)).toHaveLength(6);
    expect(html).toContain("+3 more");
  });

  it("keeps a right to left file name in its own direction", () => {
    expect(html).toContain('dir="auto" class="min-w-0 truncate text-ink [unicode-bidi:isolate]">أخبار الذكاء الاصطناعي 9 أكتوبر.md');
  });

  it("draws images as small thumbnails", () => {
    const markup = renderToStaticMarkup(createElement(AttachmentGallery, { images: ["/store/123e4567-e89b-42d3-a456-426614174000.png"], message, beneath: true }));
    expect(markup).toContain("h-24");
    expect(markup).not.toContain("max-h-72");
  });
});
