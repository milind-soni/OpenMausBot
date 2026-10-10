// Actual settings, store and HTTP persistence in the owned browser fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env })) || process.env.OMB_UI_E2E === "1";
if (!enabled) console.log("skipping tool selection UI: set OMB_UI_E2E=1 to install the pinned browser");
interface SavedBot { id: string; name: string; toolScope?: { allow?: string[]; deny?: string[] }; busy?: boolean }

(enabled ? it : it.skip)("saves, clears, rejects and duplicates owner tool selections without crossing bots", async () => {
  let child: ChildProcess | undefined;
  try {
    let stdout = "", stderr = "";
    let info: { ui: string; url: string };
    const launcher = new URL("./control-omb-ui.ts", import.meta.url).href;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi(['--entry', 'settings', '--mode', 'hang']); } finally { process.disconnect(); }
    `], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(stderr);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots?messages=0`).then(response => response.json())).bots;
    const initial = await bots();
    const first = initial.find(bot => bot.name === "Pepper")!;
    const second = initial.find(bot => bot.id !== first.id)!;
    const selectBot = (name: string) => evaluate(`(() => {
      const button = [...document.querySelectorAll('main > div button')].find(button => button.textContent.trim().endsWith(': ' + ${JSON.stringify(name)}));
      if (!button) throw new Error('Missing fixture bot'); button.click(); return true;
    })()`);
    const mode = (value: "all" | "custom") => evaluate(`(() => {
      const select = document.querySelector('select[aria-label="Tool selection"]');
      if (!select || select.disabled) throw new Error('Selection is unavailable');
      select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })()`);
    const fill = async (name: string, text: string) => {
      // Use the native setter for a deterministic React change, as in the
      // existing UI tests; saving still uses the real button and API.
      await evaluate(`(() => {
        const input = document.querySelector('textarea[aria-label=' + ${JSON.stringify(JSON.stringify(name))} + ']');
        if (!input || input.disabled) throw new Error('Selection field unavailable: ' + ${JSON.stringify(name)} + ', proposed ' + ${JSON.stringify(text)} + ', status ' + document.querySelector('[role=status]')?.textContent);
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true })); return true;
      })()`);
    };
    const scope = async (id = first.id) => (await bots()).find(bot => bot.id === id)?.toolScope;
    await selectBot(first.name); await click("Open settings"); await click("Access");
    expect(await snapshot()).toContain("All current tools");
    await mode("custom");
    await fill("Allow (one per line)", "native:*\nmcp:mail:read_notes");
    await fill("Exclude (one per line)", "mcp:mail:send");
    await click("Save tool selection");
    const selected = { allow: ["native:*", "mcp:mail:read_notes"], deny: ["mcp:mail:send"] };
    await expect.poll(() => scope()).toEqual(selected);
    expect(await snapshot()).toContain("Custom selection saved");

    await fill("Allow (one per line)", "native:read*");
    expect(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save tool selection')?.disabled")).toBe(true);
    expect(await scope()).toEqual(selected);
    await fill("Allow (one per line)", "");
    expect(await snapshot()).toContain("An empty Allow list selects no tools");
    expect(await snapshot()).toContain("This engine cannot limit native tools");
    await click("Save tool selection");
    await expect.poll(() => scope()).toEqual({ allow: [], deny: ["mcp:mail:send"] });
    expect(await snapshot()).toContain("No tools selected");
    await mode("all"); await click("Save tool selection");
    await expect.poll(() => scope()).toBeUndefined();

    // A rejected save must leave the server and saved status unrestricted,
    // while keeping the edit available for a successful retry.
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (init?.method === 'PATCH' && typeof init.body === 'string' && Object.hasOwn(JSON.parse(init.body), 'toolScope')) {
          window.fetch = fetch;
          return Promise.resolve(new Response(JSON.stringify({error:'Fixture selection rejected'}), {status:409,headers:{'content-type':'application/json'}}));
        } return fetch(input, init);
      }; return true;
    })()`);
    await mode("custom"); await fill("Allow (one per line)", "native:*");
    await click("Save tool selection");
    await expect.poll(snapshot).toContain("Fixture selection rejected");
    expect(await scope()).toBeUndefined();
    await click("Save tool selection");
    await expect.poll(() => scope()).toEqual({ allow: ["native:*"], deny: [] });

    // Hold a failure across a real bot switch. Its late error and draft
    // cannot populate the second bot's editor or write to that bot.
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (init?.method === 'PATCH' && typeof init.body === 'string' && Object.hasOwn(JSON.parse(init.body), 'toolScope')) {
          window.fetch = fetch;
          return new Promise(resolve => { window.rejectSelection = () => resolve(new Response(JSON.stringify({error:'Late first-bot error'}), {status:409,headers:{'content-type':'application/json'}})); });
        } return fetch(input, init);
      }; return true;
    })()`);
    await fill("Allow (one per line)", ""); await click("Save tool selection");
    await expect.poll(snapshot).toContain("Saving tool selection…");
    await selectBot(second.name);
    await click("Open settings"); await click("Access");
    await expect.poll(snapshot).toContain("All current tools");
    await evaluate("window.rejectSelection(); true");
    expect(await snapshot()).not.toContain("Late first-bot error");
    expect(await scope(second.id)).toBeUndefined();
    expect(await scope()).toEqual({ allow: ["native:*"], deny: [] });

    await selectBot(first.name);
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input) === '/api/bots' && init?.method === 'POST') {
          window.duplicateCreation = JSON.parse(init.body);
          window.fetch = fetch;
          return fetch(input, init).then(async response => {
            window.scopeAtCreation = (await response.clone().json()).bot.toolScope; return response;
          });
        } return fetch(input, init);
      }; return true;
    })()`);
    await click("Duplicate selected bot");
    await expect.poll(() => evaluate("window.scopeAtCreation")).toEqual({ allow: ["native:*"], deny: [] });
    expect(await evaluate("window.duplicateCreation.settings.toolScope")).toEqual({ allow: ["native:*"], deny: [] });
    await expect.poll(async () => (await bots()).find(bot => bot.name === `${first.name} copy`)?.toolScope).toEqual({ allow: ["native:*"], deny: [] });

    await selectBot(first.name); await click("Open settings"); await click("Access");
    await runControlOmb(["send", "--bot", first.id, "--text", "Stay active for the settings test.", "--url", info.url]);
    await expect.poll(async () => (await bots()).find(bot => bot.id === first.id)?.busy).toBe(true);
    await expect.poll(() => evaluate("document.querySelector('select[aria-label=\"Tool selection\"]')?.disabled")).toBe(true);
    expect(await snapshot()).toContain("Wait until this bot finishes all active tasks");
    await runControlOmb(["interrupt", "--bot", first.id, "--url", info.url]);
    await runControlOmb(["wait", "--bot", first.id, "--timeout", "30", "--url", info.url]);
    await expect.poll(() => evaluate("document.querySelector('select[aria-label=\"Tool selection\"]')?.disabled")).toBe(false);
  } finally {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  }
}, 900_000);
