// Full-app regression through the existing disposable browser harness. No
// real provider, OAuth account, MCP package, or user data is used.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { BOT_ROLES, roleProfilePatch } from "../../src/lib/bot-roles.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.OMB_UI_E2E === "1";
const enabled = forced || Boolean(binary);
if (!enabled) console.log("skipping bot tools UI e2e: no agent-browser; set OMB_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced && !binary ? 600_000 : 180_000;

interface FixtureInfo { ui: string; url: string; dataDir: string; logPath: string }
interface SavedBot { id: string; name: string; soul?: string; mcpServers?: string[]; computer?: string; browser?: boolean }

describe("bot setup and tools in the real renderer", () => {
  let child: ChildProcess | undefined;
  let info: FixtureInfo;
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("creates roles, configures per-bot MCP access, and recovers a rejected preset", async () => {
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT_MS, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const press = (keys: string) => ui("press", "--keys", keys);
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then((response) => response.json())).bots;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const openTools = async () => {
      // Composer tray Tools is gone; open bot settings (mascot) then Access.
      // Accordion starts collapsed, so Access must be expanded explicitly.
      const state = await ui("snapshot", "--interactive");
      const profile = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .find(([, entry]) => entry.role === "button" && /Open .+ profile/.test(entry.name));
      expect(profile).toBeDefined();
      await ui("click", "--ref", `@${profile![0]}`);
      await click("Access");
    };
    const clickRole = async (title: string) => {
      const state = await ui("snapshot", "--interactive");
      const matches = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .filter(([, entry]) => entry.role === "button" && entry.name.startsWith(`${title} `));
      expect(matches).toHaveLength(1);
      await ui("click", "--ref", `@${matches[0][0]}`);
    };
    const dialogCount = () => evaluate("document.querySelectorAll('[role=dialog]').length");
    const original = await bots();
    const coder = BOT_ROLES.find((role) => role.id === "coder")!;

    // Hold creation in this disposable browser to exercise a close/reopen
    // while the request is pending, not just two clicks in one dialog.
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.botCreateRequests = 0;
      window.fetch = (input, init) => {
        if (String(input) === '/api/bots' && init?.method === 'POST') {
          window.botCreateRequests++;
          return new Promise(resolve => {
            window.releaseBotCreation = () => { window.fetch = fetch; resolve(fetch(input, init)); };
          });
        }
        return fetch(input, init);
      };
      return true;
    })()`);
    await press("Control+n");
    await clickRole(coder.title);
    await expect.poll(() => evaluate("window.botCreateRequests"), { timeout: 10_000 }).toBe(1);
    await press("Escape");
    expect(await dialogCount()).toBe(0);
    await press("Control+n");
    expect(await evaluate("document.querySelector('[role=dialog]')?.getAttribute('aria-busy')")).toBe("true");
    expect(await evaluate("[...document.querySelectorAll('[role=dialog] button')].filter(b => b.getAttribute('aria-label') !== 'Close').every(b => b.disabled)")).toBe(true);
    await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Blank bot')).click()");
    expect(await evaluate("window.botCreateRequests")).toBe(1);
    // Close remains usable; a slow server must not trap the user in a modal.
    await click("Close");
    expect(await dialogCount()).toBe(0);
    await press("Control+n");
    await evaluate("window.releaseBotCreation(); true");
    await expect.poll(async () => (await bots()).find((bot) => bot.name === coder.name)?.soul, { timeout: 10_000 }).toBe(coder.soul);
    const created = (await bots()).filter((bot) => !original.some((old) => old.id === bot.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject(roleProfilePatch(coder));
    expect(created[0].computer).toBe(original[0].computer);
    expect(created[0].browser).toBe(original[0].browser);
    await expect.poll(() => evaluate("document.querySelector('[role=dialog]')?.getAttribute('aria-busy')"), { timeout: 10_000 }).toBe("false");
    // The old dialog's callback must not close this newer dialog instance.
    expect(await dialogCount()).toBe(1);
    await press("Escape");
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);

    // Give the selected disposable bot real usage so its header shortcut
    // exercises the same external open action as the shipped chat header.
    await runControlOmb(["send", "--bot", created[0].id, "--text", "Reply briefly for the sidebar test.", "--url", info.url]);
    expect((await runControlOmb(["wait", "--bot", created[0].id, "--timeout", "20", "--url", info.url]) as { status: string }).status).toBe("settled");
    await openTools();
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("No MCP servers added yet.");
    const usageExpanded = () => evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Usage')?.getAttribute('aria-expanded')");
    const openHeaderUsage = async () => {
      const state = await ui("snapshot", "--interactive");
      const cost = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .filter(([, entry]) => entry.role === "button" && entry.name.includes("$0.01"));
      expect(cost).toHaveLength(1);
      await ui("click", "--ref", `@${cost[0][0]}`);
      await expect.poll(usageExpanded).toBe("true");
      expect(await snapshot()).toContain("All bots");
      // Allow subpixel rounding at the bottom edge of the scroll viewport.
      await expect.poll(() => evaluate("(() => { const row = document.querySelector('[data-bot-settings-section=usage]'); const rect = row?.getBoundingClientRect(); return rect ? Math.max(-rect.top, rect.bottom - innerHeight) : 9999; })()")).toBeLessThanOrEqual(1);
    };
    await openHeaderUsage();
    await click("Usage");
    expect(await usageExpanded()).toBe("false");
    await openHeaderUsage(); // same section, already mounted, after collapse
    const search = await ui("snapshot", "--interactive");
    const searchRef = Object.entries(search.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "textbox" && entry.name === "Search settings");
    expect(searchRef).toBeDefined();
    await ui("type", "--ref", `@${searchRef![0]}`, "--text", "standing");
    expect(await evaluate("document.querySelector('[aria-label=\"Search settings\"]')?.value")).toBe("standing");
    await openHeaderUsage(); // a stale search must not hide an external target
    expect(await evaluate("document.querySelector('[aria-label=\"Search settings\"]')?.value")).toBe("");
    await ui("screenshot", "--out", `${info.logPath}.settings.png`);
    await click("Overview");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Optional ways to customize this bot. You can start chatting now.");
    await click("Access");
    await click("Add an MCP server…");
    await click("Paste config");
    const pasted = await ui("snapshot", "--interactive");
    const textarea = Object.entries(pasted.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "textbox" && entry.name === "Paste config");
    expect(textarea).toBeDefined();
    await ui("type", "--ref", `@${textarea![0]}`, "--text", JSON.stringify({ mcpServers: {
      fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    } }));
    await click("Add servers");
    const registry = async () => (await fetch(`${info.url}/api/mcp/servers`).then((response) => response.json())).servers;
    await expect.poll(registry, { timeout: 10_000 }).toMatchObject([{ name: "fixture", enabled: false }]);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Turn fixture on");
    await click("Turn fixture on");
    await expect.poll(registry, { timeout: 10_000 }).toMatchObject([{ name: "fixture", enabled: true }]);
    await press("Escape");
    await openTools();
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Let this bot use fixture\"]')?.getAttribute('aria-checked')"), { timeout: 10_000 }).toBe("true");
    await click("Let this bot use fixture");
    await expect.poll(async () => (await bots()).find((bot) => bot.id === created[0].id)?.mcpServers, { timeout: 10_000 }).toEqual([]);
    await press("Escape");
    await openTools();
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Let this bot use fixture\"]')?.getAttribute('aria-checked')"), { timeout: 10_000 }).toBe("false");

    // Opening New Bot above settings must replace the old modal, not leave
    // two focus traps competing. Escape closes only the one remaining layer.
    await press("Control+n");
    expect(await dialogCount()).toBe(1);
    await press("Shift+Tab");
    expect(await evaluate("document.querySelector('[role=dialog]')?.contains(document.activeElement)")).toBe(true);
    await press("Tab");
    expect(await evaluate("document.querySelector('[role=dialog]')?.contains(document.activeElement)")).toBe(true);
    await press("Escape");
    expect(await dialogCount()).toBe(0);

    // Only this disposable page intercepts one profile PATCH. POST really
    // persists a bot, so recovery must show that bot instead of orphaning it.
    const beforeFailure = await bots();
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const path = input instanceof Request ? input.url : String(input);
        if (init?.method === 'PATCH' && /\\/api\\/bots\\/[^/]+$/.test(path) && typeof init.body === 'string' && JSON.parse(init.body).soul) {
          window.fetch = fetch;
          return Promise.resolve(new Response(JSON.stringify({error:'Fixture preset rejected'}), {status:409, headers:{'content-type':'application/json'}}));
        }
        return fetch(input, init);
      };
      return true;
    })()`);
    const ops = BOT_ROLES.find((role) => role.id === "ops")!;
    await press("Control+n");
    await clickRole(ops.title);
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(beforeFailure.length + 1);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Your bot was created, but its preset could not be fully applied.");
    expect((await bots()).filter((bot) => !beforeFailure.some((old) => old.id === bot.id))).toMatchObject([{ name: ops.name }]);
    expect(await dialogCount()).toBe(1);
    expect(await snapshot()).toContain("Standing instructions");
    await press("Escape");
    expect(await dialogCount()).toBe(0);
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((entry) => entry.type === "error")).toEqual([]);
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(info.logPath)).toBe(true);
  }, LAUNCH_TIMEOUT_MS + 180_000);
});
