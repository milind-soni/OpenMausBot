import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.log("skipping prompt inspector UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("inspects real captured turns, compares requests, refreshes, and restores keyboard focus", async () => {
  let child: ChildProcess | undefined;
  let fixtureHandle: string | undefined;
  let fixtureLog: string | undefined;
  let succeeded = false;
  try {
    let stdout = "", stderr = "";
    let info: { ui: string; url: string; botId: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    fixtureHandle = info!.ui;
    fixtureLog = info!.logPath;
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const target = async (name: string, roles: string[]) => {
      let matches: Array<[string, { name: string; role: string }]> = [];
      await expect.poll(async () => {
        const { refs } = await ui("snapshot");
        matches = Object.entries(refs as Record<string, { name: string; role: string }>).filter(([, element]) => element.name === name && roles.includes(element.role));
        return matches.length;
      }, { timeout: 10_000, message: `one ${roles.join("/")} named ${name}` }).toBe(1);
      return `@${matches[0][0]}`;
    };
    const click = async (name: string) => {
      try { return await ui("click", "--ref", await target(name, ["button", "checkbox", "menuitem"])); }
      catch (error) { throw new Error(`Click ${name}: ${error}\n${(await ui("snapshot")).snapshot}`); }
    };
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const control = (...args: string[]) => runControlOmb([...args, "--url", info.url]);
    await control("send", "--bot", info.botId, "--text", "Summarize the capture fixture.");
    await control("wait", "--bot", info.botId, "--timeout", "30");
    await click("Prompt inspector");
    await expect.poll(snapshot).toContain("Input sent to the agent");
    expect((await ui("eval", "--js", "document.activeElement?.getAttribute('aria-label')")).result).toBe("Close prompt inspector");
    expect(await snapshot()).toContain("Summarize the capture fixture.");
    await click("Diagnostics");
    expect((await ui("eval", "--js", "document.querySelector('pre')?.textContent")).result).toContain('"status": "completed"');
    await click("Close prompt inspector");
    expect((await ui("eval", "--js", "document.activeElement?.getAttribute('aria-label')")).result).toBe("Prompt inspector");
    await control("send", "--bot", info.botId, "--text", "Continue with a second request.");
    await control("wait", "--bot", info.botId, "--timeout", "30");
    await click("Prompt inspector");
    await click("Changes");
    await expect.poll(snapshot).toContain("First changed line:");
    await ui("eval", "--js", "Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {} })");
    await click("Copy view");
    await expect.poll(snapshot).toContain("Copied");
    await click("Refresh");
    await expect.poll(snapshot).toContain("Continue with a second request.");
    await expect.poll(snapshot).toContain("Copy view");
    expect(await snapshot()).not.toContain('button "Copied"');
    await click("Agent input");
    await ui("type", "--ref", await target("Find in this view", ["textbox"]), "--text", "Continue with a second request.");
    await click("Next");
    expect((await ui("eval", "--js", "document.querySelector('mark')?.textContent")).result).toBe("Continue with a second request.");
    const screenshot = join(ROOT, ".omb-scratch", "verify-evidence", "prompt-inspector.png");
    await ui("screenshot", "--out", screenshot);
    await ui("press", "--keys", "Escape");
    await expect.poll(async () => (await ui("eval", "--js", "document.activeElement?.getAttribute('aria-label')")).result).toBe("Prompt inspector");
    const consoleResult = await ui("console");
    expect(JSON.stringify(consoleResult)).not.toMatch(/Uncaught|ReferenceError/);
    console.info(JSON.stringify({ fixture: info!, screenshot, capturedInput: true, diff: true, refresh: true, focusReturn: true }));
    succeeded = true;
  } finally {
    if (!succeeded && fixtureHandle && fixtureLog) {
      try {
        const result = await runControlOmb(["ui", "snapshot", "--ui", fixtureHandle]);
        writeFileSync(`${fixtureLog}.prompt-inspector-failure.json`, JSON.stringify(result, null, 2));
        await runControlOmb(["ui", "screenshot", "--ui", fixtureHandle, "--out", `${fixtureLog}.prompt-inspector-failure.png`]);
        console.info(JSON.stringify({ failureEvidence: `${fixtureLog}.prompt-inspector-failure.json` }));
      } catch { /* The original failure remains authoritative if the browser stopped. */ }
    }
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 180_000 : 720_000);
