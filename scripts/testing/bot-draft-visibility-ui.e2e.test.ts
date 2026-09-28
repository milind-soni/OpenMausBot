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
const enabled = Boolean(binary) || process.env.OMB_UI_E2E === "1";
if (!enabled) console.log("skipping draft visibility UI: set OMB_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("creates a restricted bot from the full draft dialog without widening its audience", async () => {
  let child: ChildProcess | undefined;
  try {
    let stdout = "", stderr = "";
    let info: { ui: string; url: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null) throw new Error(stderr);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const bots = async () => (await fetch(`${info.url}/api/bots?messages=0`).then(response => response.json())).bots as Array<{ id: string; visibility?: string }>;
    const before = await bots();
    await ui("press", "--keys", "Control+n");
    await expect.poll(snapshot).toContain("Who can see it");
    // The dialog appears before its defaults request completes. Never click
    // the disabled Create button while the fixture is still loading its draft.
    await expect.poll(async () => (await ui("eval", "--js", "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === 'Create bot')?.disabled")).result).toBe(false);
    // Native select popups do not accept routed keys consistently in headless
    // macOS. Exercise the real select's change handler without the OS popup;
    // creation and its resulting audience still run through the real UI/API.
    const state = await ui("snapshot");
    const audience = Object.entries(state.refs as Record<string, { name: string; role: string }>).find(([, item]) => item.role === "combobox" && item.name === "Who can see it");
    expect(audience).toBeDefined();
    await ui("eval", "--js", "(() => { const select = document.querySelector('[data-new-bot-visibility] select'); select.value = 'admins'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelector('[data-new-bot-visibility] select')?.value")).result).toBe("admins");
    await ui("click", "--name", "Create bot");
    await expect.poll(async () => (await bots()).length, { timeout: 15_000 }).toBe(before.length + 1);
    const created = (await bots()).find(bot => !before.some(old => old.id === bot.id));
    expect(created?.visibility).toBe("admins");
    await expect.poll(snapshot).not.toContain('dialog "New bot"');
  } finally { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); }
}, 720_000);
