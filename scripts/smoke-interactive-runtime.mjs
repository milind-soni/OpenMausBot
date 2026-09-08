// Browser regression for the actual offline bundle. Playwright is an optional
// QA tool: install it separately or set OMB_PLAYWRIGHT_MODULE to its module path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  INTERACTIVE_CHOICE_EXAMPLE,
  INTERACTIVE_COMPARE_EXAMPLE,
  INTERACTIVE_HEATMAP_EXAMPLE,
} from "../shared/interactive-examples.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.OMB_PLAYWRIGHT_MODULE || "playwright");
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = "src/interactive/runtime.tsx";
const refIndex = process.argv.indexOf("--runtime-ref");
const source = refIndex < 0 ? readFileSync(join(repository, runtimePath), "utf8")
  : execFileSync("git", ["show", `${process.argv[refIndex + 1]}:${runtimePath}`], { cwd: repository, encoding: "utf8" });
const bundle = await build({
  stdin: { contents: source, loader: "tsx", resolveDir: join(repository, "src/interactive"), sourcefile: "runtime.tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
const browser = await chromium.launch({ headless: true, ...(process.env.OMB_BROWSER_CHANNEL ? { channel: process.env.OMB_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext();
const cases = [
  { name: "reactive work plan", source: INTERACTIVE_CHOICE_EXAMPLE },
  { name: "reactive heatmap", source: INTERACTIVE_HEATMAP_EXAMPLE },
  { name: "reactive comparison", source: INTERACTIVE_COMPARE_EXAMPLE },
  { name: "invalid numeric range", source: 'root = NumberInput("Range", 8, 1, 1, 2);', error: true },
  { name: "mismatched chart", source: 'root = Chart("Chart", ["A", "B"], [{name:"Series",values:[1]}], "bar");', error: true },
  { name: "mismatched heatmap rows", source: 'root = Heatmap("Map", ["A", "B"], ["X"], [[1]], 0);', error: true },
  { name: "mismatched heatmap columns", source: 'root = Heatmap("Map", ["A"], ["X", "Y"], [[1]], 0);', error: true },
  // Fault injection exercises a genuine exception during React rendering,
  // independently of the malformed props handled by InvalidProps above.
  { name: "unexpected render exception", source: 'root = Metric("Value", 3, "units");', error: true, fault: true },
];
try {
  for (const test of cases) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="host"></div>');
    await page.evaluate(({ script, test }) => {
      window.runtimeOutcomes = [];
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      window.runtimeInit = { channel: "omb-interactive-v1", token: "runtime-regression", type: "init", value: { source: test.source } };
      addEventListener("message", event => {
        if (event.source !== frame.contentWindow || event.data?.channel !== "omb-interactive-v1") return;
        if (event.data.type === "boot") frame.contentWindow.postMessage(window.runtimeInit, "*");
        else if (event.data.token === "runtime-regression" && ["ready", "error"].includes(event.data.type))
          window.runtimeOutcomes.push(event.data);
      });
      const fault = test.fault ? 'Intl.NumberFormat = function () { throw new Error("Injected render failure"); };' : "";
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'"><div id="root"></div><script>${fault}${script}</script>`;
      document.querySelector("#host").append(frame);
    }, { script, test });
    await page.waitForFunction(type => window.runtimeOutcomes.some(event => event.type === type), test.error ? "error" : "ready", { timeout: 5000 });
    const first = await page.evaluate(() => window.runtimeOutcomes);
    if (test.error) assert(first.every(event => event.type === "error"), `${test.name}: false ready outcome`);
    else {
      assert(first.every(event => event.type === "ready"), `${test.name}: unexpected error`);
      const frame = page.frames().find(frame => frame.parentFrame());
      assert((await frame.locator("#root").innerText()).trim(), `${test.name}: ready before content`);
    }
    // A repeated handshake must replay the final error, never stale readiness.
    await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage(window.runtimeInit, "*"));
    await page.waitForFunction(count => window.runtimeOutcomes.length > count, first.length);
    const replay = await page.evaluate(() => window.runtimeOutcomes.at(-1).type);
    assert.equal(replay, test.error ? "error" : "ready", `${test.name}: wrong replay outcome`);
    assert.deepEqual(errors, [], `${test.name}: uncaught browser error`);
    console.log(`PASS ${test.name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
