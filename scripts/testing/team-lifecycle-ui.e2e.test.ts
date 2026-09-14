import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.log("skipping team lifecycle UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("creates an empty team, moves bots, and manages shared instructions in the renderer", async () => {
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
    const type = async (name: string, text: string) => {
      const ref = await target(name, ["textbox"]);
      await ui("click", "--ref", ref);
      // The browser's type action focuses again and collapses selections.
      // Clear through the native input event first, including on rename.
      await ui("eval", "--js", "(() => { const input = document.activeElement; if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error('Expected focused input'); input.select(); return true; })()");
      await ui("press", "--keys", "Backspace");
      return ui("type", "--ref", ref, "--text", text);
    };
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const manage = async (name: string) => {
      // Native summary nodes have no refs in the pinned browser snapshot.
      const selector = `[data-team-key=${JSON.stringify(name)}] summary`;
      await expect.poll(async () => (await ui("eval", "--js", `Boolean(document.querySelector(${JSON.stringify(selector)}))`)).result,
        { timeout: 10_000 }).toBe(true);
      await ui("eval", "--js", `(() => { const summary = document.querySelector(${JSON.stringify(selector)}); if (!summary.parentElement.open) summary.click(); return summary.parentElement.open; })()`);
    };
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);
    const control = (...args: string[]) => runControlOmb([...args, "--url", info.url]);
    const a = (await control("new-bot", "--name", "Researcher", "--section", "Research") as any).bot;
    const b = (await control("new-bot", "--name", "Engineer", "--section", "Engineering") as any).bot;

    await click("New or share");
    await click("Create team");
    await type("Team name", "Delivery");
    await click("Create team");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "Delivery"');
    expect((await api("/api/bots?messages=0")).sections).toContain("Delivery");
    await click("Tools");
    await click("Team map");
    await manage("Delivery");
    await click("Move bots to Delivery");
    await click("Researcher");
    await click("Engineer");
    await click("Move 2 bots");
    await expect.poll(async () => (await api("/api/bots?messages=0")).bots.filter((bot: any) => bot.section === "Delivery").length).toBe(2);
    await manage("Delivery");
    await click("Edit Delivery shared instructions");
    await type("Delivery shared instructions", "Research first, then build and review.");
    await click("Save shared instructions");
    expect((await api("/api/section-context?section=Delivery")).text).toBe("Research first, then build and review.");

    await ui("eval", "--js", "location.reload(); true");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain('button "Delivery"');
    await click("Tools");
    await click("Team map");
    await manage("Delivery");
    expect(await snapshot()).toContain("Edit Delivery shared instructions");
    // A second fixture client moves the bots out. SSE must keep the empty
    // team visible and make rename/delete available without a reload.
    await api("/api/sidebar-sections", "POST", { name: "", botIds: [a.id, b.id] });
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Rename Delivery team");
    await click("Rename Delivery team");
    await type("Team name", "Launch");
    await click("Save name");
    await manage("Launch");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Edit Launch shared instructions");
    expect((await api("/api/section-context?section=Launch")).text).toBe("Research first, then build and review.");
    const screenshot = join(ROOT, ".omb-scratch", "verify-evidence", "team-lifecycle.png");
    await ui("screenshot", "--out", screenshot);
    await click("Delete Launch team");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('alertdialog "Delete Launch team?"');
    await click("Delete team");
    await expect.poll(async () => (await api("/api/bots?messages=0")).sections.includes("Launch")).toBe(false);
    const consoleResult = await ui("console");
    expect(JSON.stringify(consoleResult)).not.toMatch(/Uncaught|ReferenceError/);
    console.info(JSON.stringify({ fixture: info!, screenshot, emptyTeam: true, multiBotMove: true, reload: true, renameAndDelete: true }));
    succeeded = true;
  } finally {
    if (!succeeded && fixtureHandle && fixtureLog) {
      try {
        const result = await runControlOmb(["ui", "snapshot", "--ui", fixtureHandle]);
        writeFileSync(`${fixtureLog}.team-lifecycle-failure.json`, JSON.stringify(result, null, 2));
        await runControlOmb(["ui", "screenshot", "--ui", fixtureHandle, "--out", `${fixtureLog}.team-lifecycle-failure.png`]);
        console.info(JSON.stringify({ failureEvidence: `${fixtureLog}.team-lifecycle-failure.json` }));
      } catch { /* The original failure remains authoritative if the browser stopped. */ }
    }
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 180_000 : 720_000);
