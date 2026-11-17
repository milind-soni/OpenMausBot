import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExtensionsMenu, extensionsOf } from "./ExtensionsMenu";

const render = (ready: boolean, extensions: Array<{ id: string; name: string }> | null) =>
  renderToStaticMarkup(createElement(ExtensionsMenu, { ready, extensions, onList: vi.fn(), onOpen: vi.fn() }));

describe("the Extensions menu", () => {
  it("lists each installed extension by name for the person holding the browser", () => {
    const html = render(true, [{ id: "a".repeat(32), name: "Vault" }, { id: "b".repeat(32), name: "Notes" }]);
    expect(html).toContain('aria-label="Extensions"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain("Vault");
    expect(html).not.toContain("chrome://");
  });

  it("asks the person to take control first, and says when there is nothing to open", () => {
    expect(render(false, [{ id: "a".repeat(32), name: "Vault" }])).toContain("Take control to open an extension.");
    expect(render(false, [{ id: "a".repeat(32), name: "Vault" }])).not.toContain("Vault");
    expect(render(true, [])).toContain("No extensions with a page to open in this browser.");
  });

  it("keeps only well-formed entries from the browser", () => {
    expect(extensionsOf([{ id: "x", name: "Ok" }, { id: 1, name: "Bad" }, null, "y"])).toEqual([{ id: "x", name: "Ok" }]);
    expect(extensionsOf(undefined)).toEqual([]);
  });
});
