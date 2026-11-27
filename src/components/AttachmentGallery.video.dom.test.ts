// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentGallery } from "./AttachmentGallery";

const message = { threadId: "thread-one", messageId: "message-two" };
const file = { path: "/workspace/trip.mov", name: "trip.mov", linked: true };
const url = `/api/threads/thread-one/messages/message-two/file?media=${"a".repeat(43)}`;

describe("a chat video the player cannot decode", () => {
  let root: Root, host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ url, mime: "video/quicktime", bytes: 300 * 1024 * 1024 }), {
      headers: { "content-type": "application/json", "x-openmausbot-media": "1" },
    })));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps a clip that has not loaded to a short strip, so its file chip stays in view", async () => {
    await act(async () => root.render(createElement(AttachmentGallery, { files: [file], message })));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Preview trip.mov"]')!;
    expect(button.parentElement!.className).toContain("h-28");
    expect(button.parentElement!.className).not.toContain("aspect-");
  });

  it("streams a large file, and when it will not play offers a download of the same link instead of a dead player", async () => {
    await act(async () => root.render(createElement(AttachmentGallery, { files: [file], message })));
    expect(host.textContent).toContain("Plays on request");
    expect(host.textContent).not.toContain("25 MB");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Preview trip.mov"]')!.click());
    const video = host.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(`${url}#t=0.001`);

    await act(async () => { video.dispatchEvent(new Event("error")); });
    expect(host.querySelector("video")).toBeNull();
    expect(host.querySelector("[role=alert]")!.textContent).toBe("This video cannot be played here. You can still save a copy.");
    const download = host.querySelector<HTMLAnchorElement>('a[aria-label="Download trip.mov"]')!;
    expect(download.getAttribute("href")).toBe(url);
    expect(download.getAttribute("download")).toBe("trip.mov");
    expect(download.textContent).toBe("Download");
  });
});
