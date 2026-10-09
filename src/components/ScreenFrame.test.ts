import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { ScreenFrame, screenFramePreview } from "./ScreenFrame";

const shot = (patch: Partial<Message> = {}): Message =>
  ({ id: "shot 1", role: "bot", kind: "screen", hasImage: true, at: 1, ...patch }) as Message;

describe("screen frame preview", () => {
  it("loads the frame from the image route and picks a download extension from the mime type", () => {
    expect(screenFramePreview({ threadId: "t1", messageId: "shot 1" })).toMatchObject({
      src: "/api/threads/t1/messages/shot%201/image",
      name: "Bot's screen",
      downloadUrl: "/api/threads/t1/messages/shot%201/image",
      downloadName: "screen.png",
    });
    expect(screenFramePreview({ threadId: "t1", messageId: "shot" }, "image/jpeg").downloadName).toBe("screen.jpg");
  });

  it("renders the frame as a zoomable button and keeps the viewer closed", () => {
    const html = renderToStaticMarkup(createElement(ScreenFrame, { threadId: "t1", message: shot({ mime: "image/jpeg" }) }));

    expect(html).toContain("<button");
    expect(html).toContain("aria-label=\"Preview Bot&#x27;s screen\"");
    expect(html).toContain("src=\"/api/threads/t1/messages/shot%201/image\"");
    expect(html).toContain("alt=\"Bot&#x27;s screen\"");
    // the zoom badge shows on hover and keyboard focus only
    expect(html).toContain("group-hover/image:opacity-100");
    expect(html).toContain("group-focus-within/image:opacity-100");
    // the frame keeps its transcript sizing
    expect(html).toContain("max-w-[min(42rem,78%)]");
    expect(html).not.toContain("role=\"dialog\"");
  });

  it("renders nothing for a screen message with no image", () => {
    expect(renderToStaticMarkup(createElement(ScreenFrame, { threadId: "t1", message: shot({ hasImage: undefined }) }))).toBe("");
  });
});
