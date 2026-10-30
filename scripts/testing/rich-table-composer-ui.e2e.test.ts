// The transcript's sticky table header must yield to the message entry field
// where they overlap: elementFromPoint inside the entry returns the composer,
// never the header. Real renderer against the fake-engine fixture. Needs the
// pinned agent-browser binary: runs when one resolves (tools directory,
// OMB_AGENT_BROWSER_PATH, or PATH) or OMB_UI_E2E=1 asks for the verified
// download; otherwise skipped.
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
if (!enabled) console.info("skipping rich table composer UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const ENTRY = 'textarea[aria-label="Message Pepper"]';
// The list lines above the table leave the transcript headroom to scroll
// upward: the chat settles at the bottom with the header in view above the
// entry field, and the probe lowers the band onto the field from there.
const filler = Array.from({ length: 60 }, (_, index) => `- Reference line ${index + 1}`).join("\n");
const rows = Array.from({ length: 40 }, (_, index) => `| Row ${index + 1} | value ${index + 1} | note ${index + 1} |`).join("\n");
const REPLY = `Reference extract follows.\n\n${filler}\n\n| Label | Value | Note |\n| --- | --- | --- |\n${rows}`;

// Scrolls the transcript until the header band straddles the entry field's
// center - down when the band sits below it, up when the band sits above -
// then reports who owns that point.
const PROBE = `(() => {
  const log = document.querySelector('[role="log"]');
  const scroller = log && log.closest('.glass-scroller');
  const header = log ? log.querySelector('thead') : null;
  const entry = document.querySelector('${ENTRY}');
  const composer = document.querySelector('[data-tour="composer"]');
  if (!scroller || !header || !entry || !composer) return { overlap: false, gap: null, hitIsComposer: false, hitInHeader: false };
  const entryRect = entry.getBoundingClientRect();
  const target = entryRect.top + entryRect.height / 2;
  const MARGIN = 4;
  for (let i = 0; i < 40; i += 1) {
    const band = header.getBoundingClientRect();
    if (band.top <= target && band.bottom >= target) break;
    const before = scroller.scrollTop;
    if (band.top > target) {
      scroller.scrollTop = before + Math.ceil(band.top - target + MARGIN);
    } else {
      scroller.scrollTop = before - Math.ceil(target - band.bottom + MARGIN);
    }
    if (scroller.scrollTop === before) break;
  }
  const headerRect = header.getBoundingClientRect();
  const clip = (header.closest('[role="region"]') || header).getBoundingClientRect();
  const left = Math.max(headerRect.left, clip.left, entryRect.left + 2);
  const right = Math.min(headerRect.right, clip.right, entryRect.right - 2);
  const y = entryRect.top + entryRect.height / 2;
  const gap = Math.round(headerRect.top - target);
  const overlap = right - left >= 4 && headerRect.top <= y && headerRect.bottom >= y;
  const hit = overlap ? document.elementFromPoint((left + right) / 2, y) : null;
  return {
    overlap,
    gap,
    hitIsComposer: Boolean(hit) && (hit === composer || composer.contains(hit)),
    hitInHeader: Boolean(hit) && header.contains(hit),
  };
})()`;

(enabled ? it : it.skip)("the sticky table header yields to the message entry field", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT,
      env: { ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([REPLY]), FAKE_CLAUDE_TOOL_CALLS: "[]" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;

    await expect.poll(() => evaluate(`Boolean(document.querySelector('${ENTRY}'))`), { timeout: 15_000 }).toBe(true);
    await ui("type", "--name", "Message Pepper", "--text", "Show the reference table.");
    await ui("press", "--keys", "Enter");
    const settled = await ui("wait-settle", "--timeout", "60");
    expect(settled).toMatchObject({ ok: true, status: "settled" });

    // The reply renders the table before the scroll below can find its header.
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[role="log"] thead'))`), { timeout: 15_000 }).toBe(true);

    const probeState = async () => (await evaluate(PROBE)) as { overlap: boolean; gap: number | null; hitIsComposer: boolean; hitInHeader: boolean };
    await expect.poll(probeState, { timeout: 20_000, interval: 250 }).toMatchObject({ overlap: true });
    const state = await probeState();
    expect(state).toMatchObject({ overlap: true, hitIsComposer: true, hitInHeader: false });
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 360_000 : 720_000);
