import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RenameTitle } from "./RenameTitle";

describe("RenameTitle", () => {
  it("does not expose an inert profile button when onActivate is absent", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Ind",
      onCommit: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).not.toContain("Open Ind&#x27;s profile");
    expect(markup).toContain('aria-label="Rename Ind"');
  });

  it("exposes the profile button when onActivate is provided", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Ind",
      onCommit: vi.fn(),
      onActivate: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).toContain("Open Ind&#x27;s profile");
  });
});
