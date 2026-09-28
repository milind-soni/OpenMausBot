import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScreenFrame, screenFramePreview } from "./ScreenFrame";

describe("screen frame preview", () => {
  it("names the frame and picks a download extension from the mime type", () => {
    expect(screenFramePreview("AAAA")).toMatchObject({
      src: "data:image/png;base64,AAAA",
      name: "Bot's screen",
      downloadUrl: "data:image/png;base64,AAAA",
      downloadName: "screen.png",
    });
    expect(screenFramePreview("AAAA", "image/jpeg").downloadName).toBe("screen.jpg");
  });

  it("renders the frame as a zoomable button and keeps the viewer closed", () => {
    const html = renderToStaticMarkup(createElement(ScreenFrame, { png: "AAAA", mime: "image/jpeg" }));

    expect(html).toContain("<button");
    expect(html).toContain("aria-label=\"Preview Bot&#x27;s screen\"");
    expect(html).toContain("src=\"data:image/jpeg;base64,AAAA\"");
    expect(html).toContain("alt=\"Bot&#x27;s screen\"");
    // the zoom badge shows on hover and keyboard focus only
    expect(html).toContain("group-hover/image:opacity-100");
    expect(html).toContain("group-focus-within/image:opacity-100");
    // the frame keeps its transcript sizing
    expect(html).toContain("max-w-[min(42rem,78%)]");
    expect(html).not.toContain("role=\"dialog\"");
  });
});
