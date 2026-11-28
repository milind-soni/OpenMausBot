// Real renderer and sandboxed Page, driven by Chromium against a disposable fake-engine fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping Page highlight UI e2e: set OMB_UI_E2E=1 to install the pinned browser");
const LAUNCH_TIMEOUT = forced ? 600_000 : 180_000;

const PAGE = `<!DOCTYPE html><html><head><style>
body { margin: 0; min-height: 220px; font: 24px/32px monospace; color: var(--color-text-primary); background: var(--color-background-primary); }
#phrase { position: absolute; left: 40px; top: 45px; white-space: pre; }
#pin { position: absolute; left: 40px; top: 125px; padding: 8px; }
</style></head><body><span id="phrase">Selected phrase</span><div id="pin">Pin target</div>
<script>
var moves = [];
window.addEventListener('pointermove', function (event) {
  moves.push({ buttons: event.buttons, target: event.target.id || event.target.tagName, trusted: event.isTrusted });
  if (moves.length > 20) moves.shift();
}, true);
setInterval(function () {
  var phrase = document.querySelector('#phrase').getBoundingClientRect();
  var pin = document.querySelector('#pin').getBoundingClientRect();
  var highlights = CSS.highlights && CSS.highlights.get('mausbot-point-selection');
  var y = phrase.top + phrase.height / 2;
  parent.postMessage({ fixture: 'point-highlight',
    phrase: { left: phrase.left, right: phrase.right, top: phrase.top, height: phrase.height },
    pin: { left: pin.left, top: pin.top, width: pin.width, height: pin.height },
    hits: [document.elementFromPoint(phrase.left + 1, y)?.id, document.elementFromPoint(phrase.right - 1, y)?.id],
    moves: moves, selected: String(document.getSelection()), cursor: document.documentElement.style.cursor, theme: document.documentElement.dataset.theme,
    highlights: highlights ? Array.from(highlights, function (range) { return range.toString(); }) : null,
    marks: Array.from(document.querySelectorAll('[data-mausbot-point=mark]'), function (mark) {
      return { number: mark.textContent, display: mark.style.display };
    })
  }, '*');
}, 200);
</script></body></html>`;

type Report = {
  phrase: { left: number; right: number; top: number; height: number };
  pin: { left: number; top: number; width: number; height: number };
  hits: string[];
  moves: Array<{ buttons: number; target: string; trusted: boolean }>;
  selected: string;
  cursor: string;
  theme?: string;
  highlights: string[] | null;
  marks: Array<{ number: string; display: string }>;
};

(enabled ? it : it.skip)("highlights a native text selection with a note and points at an element", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-point-highlight-"));
  let child: ChildProcess | undefined;
  try {
    const calls = join(scratch, "tool-calls.json");
    writeFileSync(calls, JSON.stringify([{ name: "show_html", server: "agents", input: { title: "Evidence", html: PAGE } }]));
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: { ...process.env, FAKE_CLAUDE_TOOL_CALLS_FILE: calls }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    let info: { ui: string; url: string; botId: string } | undefined;
    await expect.poll(() => {
      if (child!.exitCode !== null) throw new Error(`ui launch exited: ${stderr}`);
      try { info = JSON.parse(stdout.slice(stdout.indexOf("{"))); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT, interval: 250 }).toBe(true);

    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(info!.ui, "utf8")) as UiHandle;
    const mouse = (...args: string[]) => agentBrowser(browser.binary, sessionEnv(browser), ["mouse", ...args]);
    await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", "1280", "1000"]);
    await evaluate(`(() => {
      window.__pointReport = null;
      window.addEventListener('message', function (event) {
        var frame = document.querySelector('[data-page-fullscreen] iframe');
        if (frame && event.source === frame.contentWindow && event.data?.fixture === 'point-highlight') window.__pointReport = event.data;
      });
      return true;
    })()`);
    await runControlOmb(["send", "--bot", info!.botId, "--text", "Show the evidence.", "--url", info!.url]);
    expect((await runControlOmb(["wait", "--bot", info!.botId, "--timeout", "60", "--url", info!.url]) as { status: string }).status).toBe("settled");
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-app][data-app-state=live] [data-page-open]'))`), { timeout: 30_000 }).toBe(true);
    await evaluate(`document.querySelector('[data-app] [data-page-open]').click(); true`);
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-page-fullscreen] iframe') && window.__pointReport)`), { timeout: 30_000 }).toBe(true);
    const frameBox = () => evaluate(`(() => { const r = document.querySelector('[data-page-fullscreen] iframe').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`) as Promise<{ left: number; top: number }>;
    const report = () => evaluate("window.__pointReport") as Promise<Report>;
    const drag = async () => {
      const box = await frameBox();
      const { phrase, hits } = await report();
      expect(hits).toEqual(["phrase", "phrase"]);
      const y = Math.round(box.top + phrase.top + phrase.height / 2);
      await mouse("move", String(Math.round(box.left + phrase.left + 1)), String(y));
      await mouse("down");
      await mouse("move", String(Math.round(box.left + phrase.right - 1)), String(y), "--steps", "12");
      await mouse("up");
      await expect.poll(report, { timeout: 10_000 }).toMatchObject({
        selected: "Selected phrase", moves: expect.arrayContaining([expect.objectContaining({ buttons: 1, target: "phrase", trusted: true })]),
      });
    };
    await drag();
    const beforePoint = await frameBox();
    await mouse("move", String(Math.round(beforePoint.left + 10)), String(Math.round(beforePoint.top + 10)));
    await mouse("down");
    await mouse("up");
    await expect.poll(async () => (await report()).selected).toBe("");

    await ui("click", "--name", "Point");
    await expect.poll(() => evaluate(`document.querySelector('[data-page-fullscreen] button[aria-pressed=true]')?.textContent.trim()`)).toBe("Point");
    await expect.poll(async () => (await report()).cursor, { timeout: 10_000 }).toBe("crosshair");
    await drag();
    await expect.poll(() => evaluate(`![...document.querySelectorAll('[data-page-fullscreen] button')].find(b => b.textContent.trim() === 'Highlight selection')?.disabled`)).toBe(true);
    await ui("click", "--name", "Highlight selection");
    await expect.poll(() => evaluate(`document.querySelector('[data-pointed-chip]')?.textContent`), { timeout: 10_000 }).toContain("Selected phrase");
    await expect.poll(async () => (await report()).highlights, { timeout: 10_000 }).toEqual(["Selected phrase"]);
    await expect.poll(async () => (await report()).marks, { timeout: 10_000 }).toEqual([{ number: "1", display: "block" }]);

    await ui("click", "--name", "Write a note on “Selected phrase”");
    await ui("type", "--name", "Note on “Selected phrase” for the bot (optional)", "--text", "Check this evidence");
    await ui("press", "--keys", "Enter");
    await expect.poll(() => evaluate(`document.querySelector('[data-pointed-chip]')?.title`)).toContain("Check this evidence");

    const { pin } = await report();
    const box = await frameBox();
    await mouse("move", String(Math.round(box.left + pin.left + pin.width / 2)), String(Math.round(box.top + pin.top + pin.height / 2)));
    await mouse("down");
    await mouse("up");
    await expect.poll(() => evaluate(`Array.from(document.querySelectorAll('[data-pointed-chip]'), chip => chip.textContent)`), { timeout: 10_000 })
      .toEqual([expect.stringContaining("Selected phrase"), expect.stringContaining("Pin target")]);
    await expect.poll(async () => (await report()).marks, { timeout: 10_000 }).toEqual([
      { number: "1", display: "block" }, { number: "2", display: "block" },
    ]);
    if (process.env.OMB_POINT_EVIDENCE_DIR) {
      const evidence = resolve(ROOT, process.env.OMB_POINT_EVIDENCE_DIR);
      await ui("click", "--name", "Write a note on “Selected phrase”");
      await expect.poll(() => evaluate(`document.querySelector('[data-pointed-note]')?.value`)).toBe("Check this evidence");
      for (const [skin, theme] of [["daylight", "light"], ["midnight", "dark"]] as const) {
        await evaluate(`import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin(${JSON.stringify(skin)}); return true; })`);
        await expect.poll(() => evaluate("document.documentElement.dataset.skin")).toBe(skin);
        await expect.poll(report, { timeout: 10_000 }).toMatchObject({
          theme, highlights: ["Selected phrase"], marks: [{ number: "1", display: "block" }, { number: "2", display: "block" }],
        });
        await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
        const path = join(evidence, `page-point-${skin}.png`);
        await ui("screenshot", "--out", path);
        console.log(`Page point screenshot: ${path}`);
      }
    }
    await ui("click", "--name", "Clear all");
    await expect.poll(() => evaluate("document.querySelectorAll('[data-pointed-chip]').length")).toBe(0);
    await expect.poll(async () => (await report()).marks, { timeout: 10_000 }).toEqual([]);
    await expect.poll(async () => (await report()).highlights, { timeout: 10_000 }).toBeNull();
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(scratch);
  }
}, LAUNCH_TIMEOUT + 240_000);
