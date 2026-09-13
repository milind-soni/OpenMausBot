import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { request } from "../mcp-server.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping template UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

describe("additive template imports in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("adds library and file templates as sections without losing existing chats", async () => {
    let stdout = "";
    let stderr = "";
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
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);
    const control = (...args: string[]) => runControlOmb([...args, "--url", info.url]);
    await api(`/api/bots/${info!.botId}`, "PATCH", { section: "Existing work", chiefOfStaff: true });
    await control("new-bot", "--name", "Personal helper", "--section", "Personal");
    await control("send", "--bot", info!.botId, "--text", "Keep this original conversation after importing templates.");
    expect(await control("wait", "--bot", info!.botId, "--timeout", "30")).toMatchObject({ status: "settled" });
    const original = await api("/api/bots");
    const transcript = await control("messages", "--bot", info!.botId, "--limit", "10");
    const manifest = { format: "openmaus.team", version: 2, team: { name: "Sales crew", members: [
      { key: "researcher", name: "Lead finder", appearance: { color: "cyan" } },
      { key: "writer", name: "Outreach writer", appearance: { color: "purple" } },
    ] } };
    // Only the public catalog download is simulated. Import, persistence,
    // SSE and the entire React sidebar remain real and fixture-local.
    await evaluate(`(() => {
      window.templateFixture = ${JSON.stringify(manifest)};
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const path = String(input);
        const reply = value => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
        if (path === '/api/team-library/catalog') return reply({ format: 'openmaus.catalog', version: 1, repositoryUrl: '', teams: [{ slug: 'sales', name: 'Sales crew', summary: 'Fixture template', category: 'Sales', members: 2, skills: [], requires: { apps: [] } }] });
        if (path === '/api/team-library/teams/sales') return reply(window.templateFixture);
        return originalFetch(input, init);
      };
      return true;
    })()`);
    for (const source of ["library", "file"]) {
      await click("New or share");
      await click("Templates");
      if (source === "library") {
        await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "Load"');
        await click("Load");
      } else {
        await click("Import");
        // Exercise the file input's actual change handler, not the OS picker.
        await evaluate(`(() => { const input = document.querySelector('[role=dialog] input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify(window.templateFixture)], 'sales.mausteam.json', { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      }
      await expect.poll(snapshot, { timeout: 10_000 }).toContain("Adds a new team for Sales crew");
      await click("Add team");
      const section = source === "library" ? "Sales crew" : "Sales crew 2";
      await expect.poll(snapshot, { timeout: 10_000 }).toContain(`button "${section}"`);
      const current = await api("/api/bots");
      expect(current.bots.filter((bot: { section?: string }) => bot.section === section)).toHaveLength(2);
      for (const bot of original.bots) expect(current.bots.find((value: { id: string }) => value.id === bot.id)).toEqual(bot);
      expect(await control("messages", "--bot", info!.botId, "--limit", "10")).toEqual(transcript);
      expect(await snapshot()).toContain('button "Existing work"');
      expect(await snapshot()).toContain('button "Personal"');
    }
    const evidence = join(ROOT, ".omb-scratch", "verify-evidence", "template-import-sections.png");
    await ui("screenshot", "--out", evidence);
    process.stdout.write(`${JSON.stringify({ fixture: info!, screenshot: evidence, libraryAndFileImports: true, originalConversationUnchanged: true })}\n`);
  }, launchTimeout + 120_000);
});
