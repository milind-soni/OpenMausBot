import { spawn, type ChildProcess } from "node:child_process";
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
if (!enabled) console.info("skipping reply focus UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

// MOCA-263: choosing Reply showed "Replying to …" but left the caret outside
// the draft, so the reply could not be typed without clicking the box first.
(enabled ? it : it.skip)("puts the caret in the draft when a message is chosen to reply to", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const focused = () => evaluate("document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName");

    // Keyboard path: focus sits on the Reply control itself, the case the
    // rule must take focus from, and Enter activates it as a person would.
    await expect.poll(() => evaluate("Boolean(document.querySelector('button[aria-label=\"Reply to message\"]'))"), { timeout: 15_000 }).toBe(true);
    await evaluate("(() => { document.querySelector('button[aria-label=\"Reply to message\"]').focus(); return true; })()");
    expect(await focused()).toBe("Reply to message");
    await ui("press", "--keys", "Enter");
    await expect.poll(() => evaluate("/Replying to Pepper/.test(document.body.innerText)"), { timeout: 5_000 }).toBe(true);
    await expect.poll(focused, { timeout: 5_000 }).toBe("Message Pepper");
    // Typing goes straight into the reply.
    await ui("press", "--keys", "h");
    await ui("press", "--keys", "i");
    expect(await evaluate("document.querySelector('textarea[aria-label=\"Message Pepper\"]').value")).toBe("hi");

    // Cancelling the reply does not pull focus anywhere new.
    await evaluate("(() => { document.activeElement.blur(); return true; })()");
    await evaluate("(() => { document.querySelector('button[aria-label=\"Cancel reply\"]').click(); return true; })()");
    await expect.poll(() => evaluate("/Replying to Pepper/.test(document.body.innerText)"), { timeout: 5_000 }).toBe(false);
    expect(await focused()).toBe("BODY");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 240_000 : 720_000);
