// Bot pages in the real <App/> through `control-omb ui`: a page drawn to its window keeps a page's height in the chat,
// and a page that flows keeps sizing to its content. Needs the pinned agent-browser binary: runs when one resolves or
// OMB_UI_E2E=1 asks for the verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR, agentBrowser, sessionEnv, type UiHandle } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping inline page height UI e2e: set OMB_UI_E2E=1 to install the pinned browser");
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;
const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR
  ? join(resolve(ROOT, process.env.OMB_UI_EVIDENCE_DIR), "inline-page-height")
  : mkdtempSync(join(tmpdir(), "omb-page-height-"));
const ownsEvidenceDir = !process.env.OMB_UI_EVIDENCE_DIR;

const SIZE_LABEL = "c.fillStyle='#1d3557';c.font='bold 13px sans-serif';c.fillText('frame '+w+' x '+h,w-150,22);";

const MAP_LAYER = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0;overflow:hidden;font-family:var(--font-sans)}
#map{position:absolute;inset:0}
#map canvas{position:absolute;inset:0;width:100%;height:100%}
.card{position:absolute;left:16px;bottom:16px;width:230px;padding:12px 14px;border-radius:12px;background:#fff;color:#1d1d1f;box-shadow:0 6px 20px rgba(0,0,0,.2);font-size:13px;line-height:18px}
</style></head><body>
<div id="map"><canvas></canvas></div>
<div class="card"><strong>Harbour ferries</strong><br>Three routes. Next boat 14:20.</div>
<script>
var canvas=document.querySelector("canvas");
var draw=function(){var w=innerWidth,h=innerHeight;canvas.width=w;canvas.height=h;var c=canvas.getContext("2d");
c.fillStyle="#cfe3ee";c.fillRect(0,0,w,h);c.fillStyle="#a8cf9a";
c.beginPath();c.ellipse(w*0.2,h*0.3,w*0.18,h*0.22,0,0,7);c.fill();c.beginPath();c.ellipse(w*0.78,h*0.68,w*0.2,h*0.25,0,0,7);c.fill();
c.strokeStyle="rgba(29,53,87,.18)";for(var x=0;x<w;x+=40){c.beginPath();c.moveTo(x,0);c.lineTo(x,h);c.stroke()}
for(var y=0;y<h;y+=40){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke()}
c.strokeStyle="#e63946";c.lineWidth=3;c.setLineDash([8,6]);c.beginPath();c.moveTo(w*0.25,h*0.35);c.lineTo(w*0.5,h*0.5);c.lineTo(w*0.75,h*0.62);c.stroke();
${SIZE_LABEL}};
addEventListener("resize",draw);draw();
</script></body></html>`;

const MAP_PERCENT = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body,#map{height:100%;margin:0}
#map{position:relative;overflow:hidden;background:repeating-linear-gradient(45deg,#e9f1e4 0 24px,#dfeadb 24px 48px)}
.pin{position:absolute;left:45%;top:40%;width:18px;height:18px;border-radius:50% 50% 50% 0;background:#e63946;transform:rotate(-45deg)}
.label{position:absolute;left:12px;top:12px;font:bold 13px sans-serif;color:#1d3557}
</style></head><body><div id="map"><div class="pin"></div><div class="label">html, body, #map { height: 100% }</div></div></body></html>`;

const FLOWING = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;font-family:var(--font-sans);color:var(--color-text-primary)}
h2{margin:0;height:40px;font-size:18px;line-height:24px}
.row{height:56px;box-sizing:border-box;border-top:1px solid var(--color-border-primary);display:flex;align-items:center}
</style></head><body><h2>This week</h2>
<div class="row">Monday: design review</div><div class="row">Tuesday: ship the beta</div>
<div class="row">Wednesday: customer calls</div><div class="row">Thursday: retro</div></body></html>`;
const FLOWING_HEIGHT = 16 + 40 + 4 * 56 + 16;

const PAGES = [
  { key: "map-layer", input: { title: "Ferry map", html: MAP_LAYER } },
  { key: "map-layer-400", input: { title: "Ferry map at 400", html: MAP_LAYER, height: 400 } },
  { key: "map-percent", input: { title: "Percent map", html: MAP_PERCENT } },
  { key: "flowing", input: { title: "This week", html: FLOWING } },
] as const;

const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

let child: ReturnType<typeof spawn> | undefined;
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  if (ownsEvidenceDir) await removeTempDir(evidenceDir);
});

(enabled ? it : it.skip)("keeps a window-filling page at a page's height and a flowing page at its content's", async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const calls = join(evidenceDir, "tool-calls.json");
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
  }, { timeout: LAUNCH_TIMEOUT_MS, interval: 250 }).toBe(true);
  const { ui: handle, url, botId } = info!;
  const browser = JSON.parse(readFileSync(handle, "utf8")) as UiHandle;
  await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", "1280", "900"], 60_000);
  const newest = async () => (await ui("eval", handle, "--js", `(() => {
    const rows = document.querySelectorAll('[data-app]');
    const row = rows[rows.length - 1];
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    return {
      rows: rows.length,
      title: row.getAttribute('aria-label'),
      state: row.dataset.appState,
      box: Math.round(row.querySelector('[data-app-box]')?.getBoundingClientRect().height ?? 0),
      frame: Math.round(row.querySelector('iframe[data-app-frame]')?.getBoundingClientRect().height ?? 0),
    };
  })()`)).result as { rows: number; title: string; state: string; box: number; frame: number } | null;

  const measured: Record<string, { box: number; frame: number }> = {};
  for (const [index, page] of PAGES.entries()) {
    writeFileSync(calls, JSON.stringify([{ name: "show_html", server: "agents", input: page.input }]));
    await runControlOmb(["send", "--bot", botId, "--text", `Show ${page.input.title}.`, "--url", url]);
    expect((await runControlOmb(["wait", "--bot", botId, "--timeout", "60", "--url", url]) as { status: string }).status).toBe("settled");
    // A page drawn to its window never changes the frame's height: steady means the same for three seconds.
    const seen: string[] = [];
    await expect.poll(async () => {
      seen.push(JSON.stringify(await newest()));
      const last = seen.slice(-4);
      const latest = JSON.parse(last[0]!) as Awaited<ReturnType<typeof newest>>;
      return last.length === 4 && new Set(last).size === 1 && latest?.rows === index + 1 && latest.state === "live";
    }, { timeout: 30_000, interval: 1_000 }).toBe(true);
    const { box, frame } = (await newest())!;
    measured[page.key] = { box, frame };
    await ui("screenshot", handle, "--out", join(evidenceDir, `${page.key}.png`));
  }
  writeFileSync(join(evidenceDir, "heights.json"), `${JSON.stringify(measured, null, 2)}\n`);

  expect(measured).toEqual({
    "map-layer": { box: 520, frame: 520 },
    "map-layer-400": { box: 400, frame: 400 },
    "map-percent": { box: 520, frame: 520 },
    flowing: { box: FLOWING_HEIGHT, frame: FLOWING_HEIGHT },
  });
}, LAUNCH_TIMEOUT_MS + 240_000);
