import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping usage details UI: set OMB_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("renders separate cached input, uncached input and output after a real fixture turn", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string; logPath: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: 600_000, interval: 250 }).toBe(true);
    const handle = info!;
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handle.ui, ...args]) as Promise<Record<string, any>>;
    await ui("type", "--name", "Message Pepper", "--text", "Check the fixture usage");
    await ui("press", "--keys", "Enter");
    const settled = await ui("wait-settle", "--timeout", "60");
    await ui("type", "--name", "Message Pepper", "--text", "A draft that stays editable at every width");
    await ui("click", "--name", "More");
    const read = () => ui("eval", "--js", `(() => {
      const chip = document.querySelector('[data-testid="usage-chip"]');
      return { title: chip?.getAttribute('title'), text: chip?.textContent };
    })()`);
    await expect.poll(async () => (await read()).result?.title, { timeout: 15_000 }).toContain("Last message: 10 uncached input · 2 cached input · 5 output");
    const chip = (await read()).result;
    expect(chip.text).toContain("$0.01");
    expect(chip.title).not.toContain("17 read");
    expect(chip.title).not.toContain("15 new");
    // Header actions stay usable in the consolidated menu, including a
    // denied clipboard. Only this disposable browser's clipboard is stubbed.
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('fixture denial'); } }); true`);
    await ui("click", "--name", "Copy as Markdown");
    await expect.poll(() => evaluate("document.querySelector('[role=menu] [role=status]')?.textContent")).toBe("Copy failed — try download");
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedTranscript = text; } }); true`);
    await evaluate(`document.querySelector('[role=menu] button:has([role=status])').click(); true`);
    await expect.poll(() => evaluate("document.querySelector('[role=menu] [role=status]')?.textContent")).toBe("Copied");
    expect(await evaluate("window.copiedTranscript")).toContain("Check the fixture usage");
    await ui("press", "--keys", "Escape");

    const browser = JSON.parse(readFileSync(handle.ui, "utf8")) as UiHandle;
    const geometry = [];
    for (const width of [390, 800, 1100, 1600]) {
      await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), "900"]);
      if (width < 768) await expect.poll(() => evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().right")).toBeLessThanOrEqual(0);
      await ui("click", "--name", "More");
      const layout = await evaluate(`(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        return { viewport: innerWidth, scroll: document.documentElement.scrollWidth,
          menu: rect('[role=menu][aria-label=More]'), editor: rect('.mention-editor'),
          row: rect('[data-composer-row]'), controls: rect('[data-composer-actions]'),
          threads: Boolean(document.querySelector('button[aria-label="All threads"]')) };
      })()`);
      expect(await evaluate("document.querySelectorAll('[data-chathead-controls] > div').length")).toBeLessThan(6);
      expect(layout.scroll).toBeLessThanOrEqual(width);
      expect(layout.viewport).toBe(width);
      expect(layout.menu.left).toBeGreaterThanOrEqual(0);
      expect(layout.menu.right).toBeLessThanOrEqual(width);
      expect(layout.threads).toBe(true);
      expect(layout.controls.width).toBeGreaterThan(0);
      if (layout.row.width < 480) {
        expect(layout.editor.width).toBeGreaterThanOrEqual(layout.row.width - 1);
        expect(layout.editor.bottom).toBeLessThanOrEqual(layout.controls.top);
      }
      geometry.push(layout);
      await ui("screenshot", "--out", `${handle.logPath}.header-${width}.png`);
      await ui("press", "--keys", "Escape");
    }
    await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", "1100", "900"]);
    await expect.poll(() => evaluate("innerWidth")).toBe(1100);
    const density = await evaluate("localStorage.getItem('openmausbot.sidebarDensity')");
    await ui("click", "--name", "More");
    const snapshot = await ui("snapshot", "--interactive");
    const usage = Object.entries(snapshot.refs as Record<string, { name: string; role: string }>).find(([, entry]) => entry.role === "menuitem" && entry.name.startsWith("Usage"))!;
    await ui("click", "--ref", `@${usage[0]}`);
    await expect.poll(() => evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().width")).toBe(80);
    expect(await evaluate("localStorage.getItem('openmausbot.sidebarDensity')")).toBe(density);
    await ui("screenshot", "--out", `${handle.logPath}.settings-1100.png`);
    expect(await evaluate("Boolean(document.querySelector('[role=dialog]'))")).toBe(true);
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().width")).toBe(320);
    await ui("click", "--name", "More");
    await ui("click", "--name", "Inspector");
    await ui("click", "--name", "More");
    const withInspector = await ui("snapshot", "--interactive");
    const usageWithInspector = Object.entries(withInspector.refs as Record<string, { name: string; role: string }>).find(([, entry]) => entry.role === "menuitem" && entry.name.startsWith("Usage"))!;
    await ui("click", "--ref", `@${usageWithInspector[0]}`);
    await expect.poll(() => evaluate("getComputedStyle(document.querySelector('[role=dialog]')).position")).toBe("absolute");
    expect(await evaluate("document.querySelector('main').getBoundingClientRect().width")).toBeGreaterThan(400);
    await ui("screenshot", "--out", `${handle.logPath}.two-panels-1100.png`);
    await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", "1600", "900"]);
    await expect.poll(() => evaluate("getComputedStyle(document.querySelector('[role=dialog]')).position")).toBe("static");
    await ui("press", "--keys", "Escape");
    expect(await evaluate("Boolean(document.querySelector('[aria-label=Inspector]'))")).toBe(true);
    const consoleResult = await ui("console");
    expect((consoleResult.messages ?? []).filter((row: { type?: string }) => row.type === "error")).toEqual([]);
    const evidence = handle.logPath + ".usage-details.json";
    writeFileSync(evidence, JSON.stringify({ url: handle.url, botId: handle.botId, settled, chip, geometry, consoleResult }, null, 2));
    console.log(`Usage details renderer evidence: ${evidence}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, 660_000);
