import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
(enabled ? it : it.skip)("edits meeting allowances without resizing, preserves saved values, and rejects invalid limits", async () => {
  const bootstrap = `import { launchUi } from './scripts/testing/control-omb-ui.ts'; process.on('message', m => { if (m === 'stop') process.emit('SIGINT'); }); try { await launchUi([]); } finally { process.disconnect(); }`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); console.info(String(chunk)); });
  let info: { ui: string; url: string; dataDir: string; logPath: string } | undefined;
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(stderr);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: 180000 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(info!.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok).toBe(true); return response.json();
    };
    const a = await runControlOmb(["new-bot", "--url", info!.url, "--name", "Meeting Ada"]) as { bot: { id: string } };
    const b = await runControlOmb(["new-bot", "--url", info!.url, "--name", "Meeting Bo"]) as { bot: { id: string } };
    const { group } = await api("POST", "/api/groups", { name: "Meeting verification", memberIds: [a.bot.id, b.bot.id], setup: { bulletin: "Review the project together.", defaultResponder: { kind: "dynamic" } } });
    const state = await ui("snapshot", "--interactive");
    const button = Object.entries(state.refs as Record<string, { role: string; name: string }>).find(([, entry]) => entry.role === "button" && entry.name.includes("Meeting verification"));
    expect(button).toBeDefined();
    await ui("click", "--ref", `@${button![0]}`);
    await click("Meeting limits");
    const size = () => evaluate("JSON.stringify((() => {const r=document.querySelector('[role=dialog]').getBoundingClientRect();return {width:r.width,height:r.height};})())");
    const originalSize = await size();
    await click("Tokens"); await click("Time (minutes)"); await click("Budget (USD)");
    expect(await size()).toBe(originalSize);
    await click("About Replies");
    expect((await ui("snapshot")).snapshot).toContain("private participation checks, which decide who speaks next");
    await click("About Replies");
    await ui("screenshot", "--out", `${info!.logPath}.meeting-limits.png`);
    await click("Save");
    await expect.poll(() => evaluate("document.querySelectorAll('[role=dialog]').length")).toBe(0);
    const saved = (await api("GET", "/api/bots?messages=0")).groups.find((value: { id: string }) => value.id === group.id).meetingLimits;
    expect(saved).toEqual({ replies: { hardStop: 22, wrapUpAfter: 16 }, tokens: { hardStop: 100000, wrapUpAt: 70000, count: "total" }, time: { seconds: 300, wrapUpSeconds: 210 }, cost: { hardStopUsd: .5, wrapUpUsd: .35 } });
    await click("Meeting limits");
    expect(await size()).toBe(originalSize);
    for (const label of ["Replies", "Tokens", "Time (minutes)", "Budget (USD)"]) await click(label);
    expect(await size()).toBe(originalSize);
    await click("Save");
    expect((await ui("snapshot")).snapshot).toContain("Enable at least one meeting limit");
    await ui("press", "--keys", "Escape");
    expect(await evaluate("document.querySelectorAll('[role=dialog]').length")).toBe(0);
    console.info(JSON.stringify({ screenshot: `${info!.logPath}.meeting-limits.png`, saved, originalSize }));
  } finally {
    if (child.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30000 });
    expect(child.exitCode).toBe(0);
    if (info) expect(existsSync(info.dataDir)).toBe(false);
  }
}, 240000);
