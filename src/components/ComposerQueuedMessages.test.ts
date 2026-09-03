import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueuedComposerMessages } from "./ComposerQueuedMessages";

const items = [{ queueId: "q1", text: "actually stop at 10" }];

describe("QueuedComposerMessages", () => {
  it("shows a held message with Steer and a delete, in words", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, { items, onSteer: () => undefined, onCancel: () => undefined }),
    );
    expect(markup).toContain("actually stop at 10");
    expect(markup).toContain("Steer");
    expect(markup).toContain("Delete this queued message");
  });

  /** A room cannot be interrupted from every surface. Offering a Steer that
   * cannot work is worse than not offering one. */
  it("omits Steer when this surface cannot interrupt", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, { items, onCancel: () => undefined }),
    );
    expect(markup).not.toContain("Steer");
    expect(markup).toContain("actually stop at 10");
  });

  it("renders nothing when the queue is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, { items: [], onCancel: () => undefined }),
    );
    expect(markup).toBe("");
  });
});
