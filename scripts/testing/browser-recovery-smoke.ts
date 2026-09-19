// Opt-in native acceptance. Called only by the disposable browser launcher.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserRuntime } from "../../server/browser-runtime.ts";

export async function verifyBrowserRecovery(input: {
  binaryPath: string; executablePath: string; dataDir: string; previewUrl: string; testPage: string;
  screenshotPath: string;
}) {
  const playwrightPath = process.env.OMB_VERIFY_PLAYWRIGHT;
  if (!playwrightPath) throw new Error("Set OMB_VERIFY_PLAYWRIGHT to an installed Playwright module for --recovery.");
  const { chromium } = await import(playwrightPath);
  const runtime = new BrowserRuntime();
  const session = `recovery-${randomUUID()}`;
  const env = {
    HOME: input.dataDir, USERPROFILE: input.dataDir, PATH: process.env.PATH,
    AGENT_BROWSER_SESSION: session, AGENT_BROWSER_HEADLESS: "1",
    AGENT_BROWSER_EXECUTABLE_PATH: input.executablePath, AGENT_BROWSER_NO_WEBMCP: "1",
  };
  const spec = { command: input.binaryPath, args: ["mcp", "--tools", "core", "--no-webmcp"], env };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await runtime.agentRpc(session, spec, "tools/call", { name: `agent_browser_${name}`, arguments: args }) as { isError?: boolean };
    assert(!result.isError, JSON.stringify(result));
    return JSON.stringify(result);
  };
  const browser = await chromium.launch({ executablePath: input.executablePath, headless: true });
  try {
    await call("open", { url: input.testPage });
    await call("fill", { selector: "#name", text: "Preserved after idle" });
    await call("eval", { script: "window.fixtureIdentity = crypto.randomUUID(); window.fixtureIdentity" });
    const identity = await call("eval", { script: "window.fixtureIdentity" });
    // This wait is deliberately longer than the production 60-second timeout.
    const idle = delay(65_000);
    console.log("Native form filled; waiting across the production idle boundary while testing the real preview.");

    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.addInitScript(() => {
      const Original = window.EventSource;
      (window as any).fixtureSources = [];
      window.EventSource = class extends Original {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          if (String(url).endsWith("/browser/live")) (window as any).fixtureSources.push(this);
        }
      };
    });
    const actions: Array<Record<string, unknown>> = [];
    page.on("request", (request: any) => {
      if (request.url().endsWith("/browser/action")) actions.push(request.postDataJSON());
    });
    await page.goto(input.previewUrl);
    await page.getByRole("img", { name: "Live bot browser" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await page.getByRole("button", { name: "Return to bot", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Browser address" }).fill(input.testPage);
    const navigation = page.waitForResponse((response: any) => response.url().endsWith("/browser/action") && response.request().postDataJSON()?.type === "navigate");
    await page.getByRole("textbox", { name: "Browser address" }).press("Enter");
    assert((await navigation).ok());
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt="Live bot browser"]')?.naturalWidth);
    // Inject only a transport failure into a real EventSource. The component
    // must close the old server viewer and establish a new watch-only viewer.
    const offset = actions.length;
    await page.evaluate(() => (window as any).fixtureSources.at(-1).dispatchEvent(new Event("error")));
    await page.getByText("Connection interrupted. Reconnecting the browser view…").waitFor();
    await page.waitForFunction(() => (window as any).fixtureSources.length === 2);
    await page.getByRole("img", { name: "Live bot browser" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    assert.deepEqual(actions.slice(offset).filter((action) => action.type !== "ack"), []);
    await page.waitForFunction((url: string) => document.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')?.value === url, input.testPage);
    console.log("PASS: real native preview reconnects automatically, retaining the page without replaying navigation or taking control.");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    await page.screenshot({ path: input.screenshotPath });
    console.log(`Preview screenshot: ${input.screenshotPath}`);
    await idle;
    assert.equal(await call("eval", { script: "window.fixtureIdentity" }), identity);
    assert.match(await call("snapshot", {}), /Preserved after idle/);
    await call("click", { selector: "#greeting button" });
    assert.match(await call("get_text", { selector: "#result" }), /Hello, Preserved after idle/);
    console.log("PASS: the same live document and unsaved form survive 65 seconds idle; the next agent tool call completes.");
  } finally {
    await browser.close();
    try { await promisify(execFile)(input.binaryPath, ["close"], { env, timeout: 15_000 }); }
    finally { await runtime.closeAll(); }
  }
}
