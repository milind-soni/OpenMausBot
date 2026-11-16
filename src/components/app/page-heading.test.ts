// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { botHtmlDocument } from "../../../shared/app-frame/document";
import { pageOpensWithHeading } from "./page-heading";

const opens = (html: string) => pageOpensWithHeading(botHtmlDocument({ messageId: "a1", rev: 0, html }).srcdoc);

describe("whether a page opens with a heading of its own", () => {
  it("says yes when the first words are a heading, however deep it sits", () => {
    expect(opens("<!DOCTYPE html><html><head><title>Sales</title><style>h1{margin:0}</style></head><body><h1>Weekly sales</h1><p>Numbers</p></body></html>")).toBe(true);
    expect(opens("<main><header><h2>Weekly <em>sales</em></h2></header><p>Numbers</p></main>")).toBe(true);
    expect(opens("<div role=\"heading\" aria-level=\"1\">Weekly sales</div>")).toBe(true);
  });

  it("says no when something else comes first", () => {
    expect(opens("<div class=\"tiles\"><div>0.1.161</div></div><h1>Weekly sales</h1>")).toBe(false);
    expect(opens("<p>Numbers</p>")).toBe(false);
  });

  it("looks past what a page does not show", () => {
    expect(opens("<script>var title = 'x';</script><template>Draft</template><p hidden>Old</p><h1>Weekly sales</h1>")).toBe(true);
  });

  it("says no for a page a script draws", () => {
    expect(opens("<div id=\"root\"></div><script>document.getElementById('root').textContent = 'Weekly sales';</script>")).toBe(false);
    expect(pageOpensWithHeading(botHtmlDocument({ messageId: "a1", rev: 0, format: "jsx", title: "Sales", html: "export default () => <h1>Weekly sales</h1>;" }).srcdoc)).toBe(false);
  });
});
