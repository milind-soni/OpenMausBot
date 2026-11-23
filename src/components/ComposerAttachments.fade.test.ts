// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Attachment } from "@/lib/composer-attachments";
import { ComposerAttachments } from "./ComposerAttachments";

it("keeps removed uploads visible for their fade without letting them receive input", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  const files: Attachment[] = [
    { id: "file", kind: "file", name: "notes.pdf", path: "/draft/notes.pdf", size: 1 },
    { id: "photo", kind: "image", name: "photo.png", path: "", previewUrl: "blob:preview", mime: "image/png", size: 1 },
  ];
  const render = (items: Attachment[]) => flushSync(() => root.render(createElement(ComposerAttachments, {
    items, onAdd: noop, onRemove: noop, onChangeCitation: noop, onDisplayInChatBox: noop,
    notice: null, onNotice: noop, uploadImage: async () => null,
  })));
  try {
    render(files);
    const photo = host.querySelector("img");
    expect(photo?.closest(".opacity-100")?.className).toContain("starting:opacity-0");

    render(files.slice(0, 1));
    render([]);
    const exiting = [...host.querySelectorAll('[aria-hidden="true"][inert].opacity-0')];
    expect(exiting[0]?.textContent).toContain("notes.pdf");
    expect(exiting[1]?.querySelector("img")).toBe(photo);
    expect(host.querySelectorAll('[aria-hidden="true"][inert].opacity-0')).toHaveLength(2);

    render(files.slice(1));
    expect(host.querySelector("img")).toBe(photo);
    expect(host.querySelectorAll('[aria-hidden="true"][inert].opacity-0')).toHaveLength(1);
    flushSync(() => vi.advanceTimersByTime(200));
    expect(host.textContent).not.toContain("notes.pdf");
    expect(host.querySelector("img")).toBe(photo);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
