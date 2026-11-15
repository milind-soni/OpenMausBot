import { describe, expect, it } from "vitest";

import { pageSays, pageText } from "./wait-probes.ts";

describe("visible page words around HTML boundaries", () => {
  it.each([
    '<p title="hidden > Shipped">Pending</p>',
    "<p title='hidden > Shipped'>Pending</p>",
    '<p title="hidden <b>Shipped</b>">Pending</p>',
  ])("does not expose words from a quoted attribute: %s", (html) => {
    const text = pageText(html);
    expect(text).toBe("Pending");
    expect(pageSays(text, "Shipped")).toBe(false);
  });

  it.each([
    ["1 < 2 > 0", "1 < 2 > 0"],
    ["a < b <strong>ready</strong>", "a < b ready"],
  ])("keeps a less-than sign that does not start a tag: %s", (html, text) => {
    expect(pageText(html)).toBe(text);
  });

  it("keeps treating a malformed closing tag as a bogus comment", () => {
    expect(pageText("literal </ 2 > then <b>ready</b>")).toBe("literal then ready");
  });

  it.each(["script-view", "style-guide"])("does not hide the contents of a custom %s element", (name) => {
    expect(pageText(`<${name}>Visible</${name}><p>ready</p>`)).toBe("Visible ready");
  });

  it.each(["<!-->", "<!--->"])("ends an abruptly closed empty comment: %s", (comment) => {
    expect(pageText(`before${comment}after <b>ready</b>`)).toBe("before after ready");
  });

  it("still hides script and style contents with greater-than signs in their attributes", () => {
    expect(pageText('<script data-note="a > b">Shipped</script><style data-note="a > b">Shipped</style><p>Pending</p>'))
      .toBe("Pending");
  });
});
