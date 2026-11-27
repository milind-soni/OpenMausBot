// Full-app regression through the existing disposable browser harness. No
// real provider, OAuth account, MCP package, or user data is used.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { BOT_ROLES } from "../../src/lib/bot-roles.ts";
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
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("makes bots at once, configures per-bot MCP access, and recovers a rejected ready-made bot", async () => {
    let stdout = "";
    let stderr = "";
    // Windows kill("SIGINT") terminates immediately instead of delivering a
    // catchable signal. Ask the disposable launcher to run its normal cleanup.
    const launcher = new URL("./control-omb-ui.ts", import.meta.url).href;
    const bootstrap = `import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi([]); } finally { process.disconnect(); }`;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT_MS + 120_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const press = (keys: string) => ui("press", "--keys", keys);
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then((response) => response.json())).bots;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    // The bot's panel opens from the chat header's pill; click it only while closed.
    const openPanel = () => expect.poll(() => evaluate(`(() => {
      if (document.querySelector('[data-chathead-pill][aria-expanded="true"]')) return true;
      document.querySelector('[data-chathead-pill]')?.click();
      return false;
    })()`), { timeout: 10_000 }).toBe(true);
    // Its MCP servers are on Bot settings → Apps it can use.
    const openApps = async () => {
      await openPanel();
      // The panel is a lazy chunk; its gear opens Bot settings once it has painted.
      await expect.poll(() => evaluate("(() => { const gear = document.querySelector('[data-panel-gear]'); gear?.click(); return Boolean(gear); })()"), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => evaluate("Boolean(document.querySelector('[data-panel-page=\"apps\"]'))"), { timeout: 10_000 }).toBe(true);
      await evaluate("document.querySelector('[data-panel-page=\"apps\"]').click(); true");
      await expect.poll(snapshot, { timeout: 10_000 }).toContain("Connect another app");
    };
    const reviewReadyBot = async (name: string, title: string) => {
      await click("New or share");
      await click("Templates");
      await expect.poll(snapshot, { timeout: 20_000 }).toContain(`Add ${name}, ${title}`);
      await click(`Add ${name}, ${title}`);
      await expect.poll(snapshot, { timeout: 10_000 }).toContain("Starting role");
    };
    const dialogCount = () => evaluate("document.querySelectorAll('[role=dialog]').length");
    const original = await bots();

    // Hold creation in this disposable browser: New bot again while the first
    // is in flight must not make a second bot, and no dialog opens either time.
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
    await expect.poll(() => evaluate("window.botCreateRequests"), { timeout: 10_000 }).toBe(1);
    await press("Control+n");
    expect(await dialogCount()).toBe(0);
    await evaluate("window.releaseBotCreation(); true");
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(original.length + 1);
    expect(await evaluate("window.botCreateRequests")).toBe(1);
    const created = (await bots()).filter((bot) => !original.some((old) => old.id === bot.id));
    expect(created).toHaveLength(1);
    expect(original.map((bot) => bot.name)).not.toContain(created[0].name);
    expect(created[0].computer).toBe(original[0].computer);
    expect(created[0].browser).toBe(original[0].browser);
    // Its chat is open, ready for the first message.
    await expect.poll(() => evaluate("document.activeElement?.getAttribute('aria-label')"), { timeout: 10_000 }).toBe(`Message ${created[0].name}`);
    expect(await dialogCount()).toBe(0);

    // Give the selected disposable bot real usage so its header shortcut
    // exercises the same external open action as the shipped chat header.
    await runControlOmb(["send", "--bot", created[0].id, "--text", "Reply briefly for the sidebar test.", "--url", info.url]);
    expect((await runControlOmb(["wait", "--bot", created[0].id, "--timeout", "20", "--url", info.url]) as { status: string }).status).toBe("settled");
    await openApps();
    expect(await evaluate("Boolean(document.querySelector('[data-simple-mcp]'))")).toBe(false);
    const settingsPage = () => evaluate("document.querySelector('[data-settings-page][aria-current=\"page\"]')?.getAttribute('data-settings-page') ?? null");
    const searchValue = () => evaluate("document.querySelector('[data-settings-search]')?.value ?? null");
    // The panel's Usage row shows what this bot has spent and opens Settings on Spending, in Advanced mode.
    const openPanelUsage = async () => {
      await openPanel();
      // Back out of any page to the panel's tabs, then to Details.
      await expect.poll(() => evaluate(`(() => {
        const back = document.querySelector('[data-panel-back]');
        if (back) { back.click(); return false; }
        if (document.querySelector('[data-panel-tabpanel="details"]')) return true;
        [...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === 'Details')?.click();
        return false;
      })()`), { timeout: 10_000 }).toBe(true);
      const state = await ui("snapshot", "--interactive");
      const cost = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .filter(([, entry]) => entry.role === "button" && entry.name.startsWith("Usage") && entry.name.includes("$0.01"));
      expect(cost).toHaveLength(1);
      await ui("click", "--ref", `@${cost[0][0]}`);
      await expect.poll(settingsPage, { timeout: 10_000 }).toBe("usage");
    };
    // The bot panel's close button has the same name, so press the one in the Settings dialog.
    const closeSettings = async () => {
      // Spending is an Advanced page, so opening it turned Advanced mode on; Simple's chat head comes back with it off.
      await evaluate("document.querySelector('[data-settings-advanced-switch][aria-checked=\"true\"]')?.click(); true");
      await evaluate("document.querySelector('[data-settings-search]').closest('[role=dialog]').querySelector('button[aria-label=\"Close settings\"]').click(); true");
      await expect.poll(() => evaluate("Boolean(document.querySelector('[data-settings-search]'))"), { timeout: 10_000 }).toBe(false);
    };
    await openPanelUsage();
    await ui("screenshot", "--out", `${info.logPath}.settings.png`);
    const search = await ui("snapshot", "--interactive");
    const searchRef = Object.entries(search.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "textbox" && entry.name === "Search settings");
    expect(searchRef).toBeDefined();
    await ui("type", "--ref", `@${searchRef![0]}`, "--text", "standing");
    expect(await searchValue()).toBe("standing");
    await closeSettings();
    await openPanelUsage(); // a stale search must not hide an external target
    expect(await searchValue()).toBe("");
    await closeSettings();

    // Add the server where every app is added, from the panel's Connect another app.
    await openApps();
    await evaluate("document.querySelector('[data-panel-link=\"add-app\"]').click(); true");
    await click("MCP servers");
    // The registry loads on mount; Add MCP server is disabled until it finishes.
    await expect.poll(() => evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add MCP server')?.disabled"), { timeout: 10_000 }).toBe(false);
    await click("Add MCP server");
    await expect.poll(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Server link or setup command\"]'))"), { timeout: 10_000 }).toBe(true);
    const pasted = await ui("snapshot", "--interactive");
    const textarea = Object.entries(pasted.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "textbox" && entry.name === "Server link or setup command");
    expect(textarea).toBeDefined();
    await ui("type", "--ref", `@${textarea![0]}`, "--text", JSON.stringify({ mcpServers: {
      fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    } }));
    // The composer's Add shares the name: press the one beside the pasted setup.
    await evaluate(`(() => {
      for (let box = document.querySelector('textarea[aria-label="Server link or setup command"]'); box; box = box.parentElement) {
        const add = [...box.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add');
        if (add) { add.click(); return true; }
      }
      return false;
    })()`);
    const registry = async () => (await fetch(`${info.url}/api/mcp/servers`).then((response) => response.json())).servers;
    // It exits before answering, so it is saved but stays off, with the reason on its row.
    await expect.poll(registry, { timeout: 10_000 }).toMatchObject([{ name: "fixture", enabled: false }]);
    await expect.poll(() => evaluate("document.body.textContent.includes(\"Saved, but off: the test failed.\")"), { timeout: 20_000 }).toBe(true);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Turn fixture on");
    await click("Turn fixture on");
    await expect.poll(registry, { timeout: 10_000 }).toMatchObject([{ name: "fixture", enabled: true }]);
    await press("Escape");
    const useFixture = `${created[0].name} can use fixture`;
    const fixtureSwitch = () => evaluate(`document.querySelector(${JSON.stringify(`[aria-label="${useFixture}"]`)})?.getAttribute('aria-checked') ?? null`);
    await openApps();
    await expect.poll(fixtureSwitch, { timeout: 10_000 }).toBe("true");
    await click(useFixture);
    await expect.poll(async () => (await bots()).find((bot) => bot.id === created[0].id)?.mcpServers, { timeout: 10_000 }).toEqual([]);
    await press("Escape");
    await openApps();
    await expect.poll(fixtureSwitch, { timeout: 10_000 }).toBe("false");

    // New bot from above settings puts the new bot's chat in front: no
    // modal is left behind to hold the focus.
    const beforeShortcut = await bots();
    await press("Control+n");
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(beforeShortcut.length + 1);
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);

    // A failed profile step must roll back the incomplete ready-made bot and
    // leave its review open, over Templates, for a single successful retry.
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
    await reviewReadyBot(ops.name, ops.title);
    await click("Create bot");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Fixture preset rejected");
    expect((await bots()).map(bot => bot.id)).toEqual(beforeFailure.map(bot => bot.id));
    expect(await dialogCount()).toBe(2);
    await click("Create bot");
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(beforeFailure.length + 1);
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);
    expect((await bots()).filter(bot => !beforeFailure.some(old => old.id === bot.id))).toMatchObject([{ name: ops.name, soul: ops.soul }]);
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((entry) => entry.type === "error")).toEqual([]);
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(info.logPath)).toBe(true);
  }, LAUNCH_TIMEOUT_MS + 300_000);
});
