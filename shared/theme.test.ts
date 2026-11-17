import { describe, expect, it } from "vitest";

import { rehomeThemeCss, SAFE_LOOK_PARAM, themeCssProblem, themeFileSchema, themeGuide, THEME_HOOKS, themeValueLoads } from "./theme.ts";

describe("themeValueLoads", () => {
  it.each([
    'url("https://example.com/a.png")',
    "url(https://example.com/a.png)",
    "URL( 'http://example.com/a.png' )",
    'url("//example.com/a.png")',
    'url("/api/theme-assets/../bots/x/status")',
    'url("/api/theme-assets/neon/a.png?x=1")',
    'url("/api/other/a.png")',
    'url("a.png")',
    'image-set("a.png" 1x)',
    '-webkit-image-set(url("data:image/png;base64,AA") 1x)',
    'image("a.png")',
    'src("https://example.com/f.woff2")',
    "u\\72l(https://example.com/a.png)",
    'url("data:image/png;base64,AA") , url(https://example.com/b.png)',
    "url(unclosed",
  ])("loads: %s", (value) => {
    expect(themeValueLoads(value)).toBe(true);
  });

  it.each([
    "rgb(1, 2, 3)",
    'url("data:image/png;base64,iVBORw0KGgo=")',
    "url(#gradient)",
    'url("/api/theme-assets/neon-night/stars.gif")',
    "url(/api/theme-assets/neon-night/face.woff2) format(\"woff2\")",
    'local("Inter"), url("/api/theme-assets/a/b.ttf")',
    "linear-gradient(red, blue)",
  ])("stays: %s", (value) => {
    expect(themeValueLoads(value)).toBe(false);
  });
});

describe("themeCssProblem", () => {
  it("refuses what would load from elsewhere, in words a bot can act on", () => {
    expect(themeCssProblem("@import url(https://example.com/a.css);")).toMatch(/@import/);
    expect(themeCssProblem("a { background: url(https://example.com/a.png) }")).toMatch(/never the internet/);
    expect(themeCssProblem("a { background: image-set('a.png' 1x) }")).toMatch(/image-set/);
    expect(themeCssProblem("a { background: u\\72l(https://example.com/a.png) }")).toMatch(/Backslash/);
    expect(themeCssProblem("@font-face { font-family: X; src: url(https://example.com/x.woff2) }")).toMatch(/never the internet/);
  });

  it("lets local files, data: addresses, animations and escapes inside strings through", () => {
    expect(themeCssProblem([
      "/* url(https://example.com/in-a-comment) */",
      '[data-look="app"] { background: url("/api/theme-assets/neon/stars.gif") center / cover; }',
      '[data-look="chat"] { background-image: url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27/>"); }',
      '[data-look="user-bubble"]::before { content: "\\201C"; }',
      "@keyframes drift { from { background-position: 0 0 } to { background-position: 100% 0 } }",
      "@font-face { font-family: Neon; src: url(/api/theme-assets/neon/neon.woff2) format('woff2'); }",
    ].join("\n"))).toBeNull();
  });
});

it("re-homes a theme's own file addresses and no others", () => {
  expect(rehomeThemeCss('a { background: url("/api/theme-assets/old/a.png") } b { background: url("/api/theme-assets/older/a.png") }', "old", "new"))
    .toBe('a { background: url("/api/theme-assets/new/a.png") } b { background: url("/api/theme-assets/older/a.png") }');
});

it("keeps colours from naming files", () => {
  expect(themeFileSchema.safeParse({ name: "X", colors: { app: "#101010", accent: "color-mix(in srgb, #fff 20%, #000)" } }).success).toBe(true);
  expect(themeFileSchema.safeParse({ name: "X", colors: { app: "url(https://example.com/a.png)" } }).success).toBe(false);
  expect(themeFileSchema.safeParse({ name: "X", colors: { app: "image-set(a 1x)" } }).success).toBe(false);
  expect(themeFileSchema.safeParse({ name: "X", canvas: "red" }).success).toBe(false);
  expect(themeFileSchema.safeParse({ name: "X", css: "a".repeat(100_001) }).success).toBe(false);
});

it("tells a bot every hook, the rule against loading and both ways back", () => {
  const guide = themeGuide();
  for (const hook of THEME_HOOKS) expect(guide).toContain(hook.selector);
  expect(guide).toMatch(/never the internet/i);
  expect(guide).toContain("Ctrl+Alt+Shift+R");
  expect(guide).toContain(`?${SAFE_LOOK_PARAM}`);
  expect(guide).toMatch(/cannot see the result/);
});
