// Real renderer, disposable fake engine and browser profile only.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
interface FixtureInfo { ui: string; url: string; logPath: string }
interface SavedBot { id: string; name: string; modelSelection: { instanceId: string; model: string }; outbound?: unknown; connectorScopes?: unknown; fallback?: unknown }

describe("trust controls in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("refreshes receipts, saves intersecting limits and serializes memory edits", async () => {
    let output = "", errors = "";
    let info!: FixtureInfo;
    const launcher = new URL("./control-omb-ui.ts", import.meta.url).href;
    const bootstrap = `import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi(['--tool-calls', '[{"name":"Bash","input":{"command":"echo fixture"},"ok":true}]']); } finally { process.disconnect(); }`;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { errors += String(chunk); });
    child.on("error", error => { errors += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${errors}`);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 300_000, interval: 250 }).toBe(true);

    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const type = async (name: string, text: string) => {
      // The mapped browser "type" appends and refocuses the field. Clear
      // through the native input setter first, including React's input event.
      await evaluate(`(() => {
        const input = [...document.querySelectorAll('input')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(name)});
        if (!input) throw new Error('No input to clear');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await ui("type", "--name", name, "--text", text);
    };
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then(response => response.json())).bots;
    const bot = (await bots()).find(candidate => candidate.name === "Pepper")!;
    expect(bot).toBeDefined();
    const saved = async () => (await bots()).find(candidate => candidate.id === bot.id)!;
    const memory = async () => (await fetch(`${info.url}/api/team-memory?section=`).then(response => response.json())).entries as Array<{ id: string; name: string; detail: string }>;

    await click("More");
    await click("Activity");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Nothing yet.");
    await runControlOmb(["send", "--bot", bot.id, "--text", "Run the harmless fixture tool.", "--url", info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "20", "--url", info.url]);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Ran a command");
    await ui("screenshot", "--out", `${info.logPath}.activity.png`);
    await click("Close Activity");

    const interactive = await ui("snapshot", "--interactive");
    const profile = Object.entries(interactive.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "button" && entry.name === "Open Pepper's profile");
    expect(profile).toBeDefined();
    await ui("click", "--ref", `@${profile![0]}`);
    await click("Permissions");
    await click("Allow a daily amount");
    await type("Daily outbound limit", "7");
    await ui("press", "--keys", "Tab");
    await expect.poll(async () => (await saved()).outbound, { timeout: 10_000 }).toEqual({ policy: "allow", dailyCap: 7 });
    await click("Ask every time");
    await expect.poll(async () => (await saved()).outbound, { timeout: 10_000 }).toEqual({ policy: "ask", dailyCap: 7 });

    // Only this page's inventory reads are synthetic; policy writes still
    // pass through the real bot queue and server validation.
    await evaluate(`(async () => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => String(input) === '/api/connectors/connected'
        ? Promise.resolve(new Response(JSON.stringify({ services: { gmail: { connected: true } } }), { headers: {'content-type':'application/json'} }))
        : String(input) === '/api/connectors/tools'
          ? Promise.resolve(new Response(JSON.stringify({ configured: true, services: { gmail: [] } }), { headers: {'content-type':'application/json'} }))
          : original(input, init);
      await (await import('/src/components/PluginsPanel.tsx')).preloadConnectedApps(true);
      return true;
    })()`);
    await click("Access");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Limit this bot to specific apps");
    await click("Limit this bot to specific apps");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toEqual({ apps: {} });
    await click("Read");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toEqual({ apps: { gmail: "read" } });
    expect(await snapshot()).toContain("Per-app tools");
    await click("Read & write");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toEqual({ apps: { gmail: "write" } });
    await click("Limit this bot to specific apps");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toBeUndefined();
    // Seed a saved chain without any real account/auth or execution. The
    // actual Model control must remove it via the existing bot patch queue.
    const seeded = await fetch(`${info.url}/api/bots/${bot.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fallback: [{ instanceId: bot.modelSelection.instanceId, model: bot.modelSelection.model }] }),
    });
    expect(seeded.ok).toBe(true);
    await click("Model");
    expect(await snapshot()).toContain("Automatic recovery is off. This list stays inactive");
    expect(await snapshot()).toContain("Work that may have run is not replayed");
    await expect.poll(() => evaluate("Boolean(document.querySelector('button[aria-label$=\"from the fallback list\"]'))"), { timeout: 10_000 }).toBe(true);
    await evaluate("document.querySelector('button[aria-label$=\"from the fallback list\"]').click(); true");
    await expect.poll(async () => (await saved()).fallback, { timeout: 10_000 }).toEqual([]);
    expect((await saved()).modelSelection).toEqual(bot.modelSelection);
    await ui("press", "--keys", "Escape");

    await evaluate(`(() => { localStorage.setItem('omb-advanced-mode','1'); window.dispatchEvent(new StorageEvent('storage', {key:'omb-advanced-mode'})); return true; })()`);
    await click("Team map");
    const openMemory = async () => {
      await evaluate(`(() => { const menu = document.querySelector('[data-team-key=""] details'); if (!menu) throw new Error('No General team menu'); if (!menu.open) menu.querySelector('summary').click(); return true; })()`);
      await click("General team memory");
    };
    await openMemory();
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Nothing shared yet.");
    await click("Add an entry");
    await type("Name", "MCHQ");
    await type("Detail", "Mission Control HQ");
    await click("Add");
    await expect.poll(memory, { timeout: 10_000 }).toMatchObject([{ name: "MCHQ", detail: "Mission Control HQ" }]);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("MCHQ detail");
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.memoryEditRequests = 0;
      window.fetch = (input, init) => {
        if (String(input).startsWith('/api/team-memory/') && init?.method === 'PATCH') {
          window.memoryEditRequests++;
          return new Promise(resolve => { window.releaseMemoryEdit = () => { window.fetch = original; resolve(original(input, init)); }; });
        }
        return original(input, init);
      };
      return true;
    })()`);
    await type("MCHQ detail", "Reviewed HQ");
    await ui("press", "--keys", "Tab");
    await expect.poll(() => evaluate("window.memoryEditRequests"), { timeout: 10_000 }).toBe(1);
    expect(await evaluate("document.querySelector('[aria-label=\"Remove MCHQ\"]')?.disabled")).toBe(true);
    await evaluate("document.querySelector('[aria-label=\"Remove MCHQ\"]').click(); true");
    expect(await memory()).toHaveLength(1);
    await click("Close team memory");
    await openMemory();
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("MCHQ detail");
    await evaluate("window.releaseMemoryEdit(); true");
    await expect.poll(memory, { timeout: 10_000 }).toMatchObject([{ name: "MCHQ", detail: "Reviewed HQ" }]);
    // An old dialog's completion must not write its response into the new
    // dialog; reopen reads the current persisted value.
    await click("Close team memory");
    await openMemory();
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"MCHQ detail\"]')?.value"), { timeout: 10_000 }).toBe("Reviewed HQ");
    await ui("screenshot", "--out", `${info.logPath}.team-memory.png`);
    await click("Remove MCHQ");
    await expect.poll(memory, { timeout: 10_000 }).toEqual([]);
  }, 420_000);
});
