import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";
import en from "../../src/locales/en.json";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env })) || process.env.OMB_UI_E2E === "1";
const model = "fixture-local-model";
const advertised = 262144;
const override = 65536;

(enabled ? it : it.skip)("discovers capacity and saves, clears and scopes manual limits through real settings", async () => {
  const provider = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) res.end(JSON.stringify({ data: [{ id: model, context_length: req.url.startsWith("/other/") ? 32768 : advertised }] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing fake endpoint port");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  let child: ChildProcess | undefined;
  try {
    let stdout = "", stderr = "";
    let info: { ui: string; url: string; dataDir: string; logPath: string };
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
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${info.url}${path}`, body === undefined ? undefined : {
        method: path === "/api/config" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    };
    const limits = async () => (await request("/api/config")).openaiCompat.contextWindows;
    const capacity = async () => (await request("/api/instances")).instances.find((entry: any) => entry.instanceId === "openaiCompat")?.models.options.find((entry: any) => entry.id === model)?.contextWindow;
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const fill = async (name: string, value: string) => {
      await expect.poll(() => evaluate(`[...document.querySelectorAll('input')].some(input => input.getAttribute('aria-label') === ${JSON.stringify(name)} && !input.disabled)`), { timeout: 10_000 }).toBe(true);
      return evaluate(`(() => {
      const input = [...document.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === ${JSON.stringify(name)});
      if (!input || input.disabled) throw new Error('Missing enabled input: ' + ${JSON.stringify(name)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    };
    const save = en["keys.openaiCompat.contextSave"];
    const field = en["keys.openaiCompat.contextWindow"];
    await request("/api/config", { openaiCompat: { key: "fixture-key", url: endpoint, model } });
    await request("/api/instances/openaiCompat/refresh-models", {});
    await expect.poll(capacity).toBe(advertised);
    await click("Open app settings");
    await click(en["settings.section.connections"]);
    await fill(en["keys.openaiCompat.contextModel"], model);
    await expect.poll(snapshot).toContain(en["keys.openaiCompat.contextCurrent"].replace("{tokens}", advertised.toLocaleString("en-US")));

    await fill(field, String(override)); await click(save);
    await expect.poll(limits).toEqual({ [endpoint]: { [model]: override } });
    await expect.poll(capacity).toBe(override);
    const disk = JSON.parse(readFileSync(join(info.dataDir, "config.json"), "utf8"));
    expect(disk.openaiCompat.contextWindows).toEqual(await limits());
    await expect.poll(snapshot).toContain(en["keys.openaiCompat.contextSaved"]);
    await fill(field, "0");
    expect(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(save)})?.disabled`)).toBe(true);
    expect(await limits()).toEqual({ [endpoint]: { [model]: override } });
    await fill(field, ""); await click(save);
    await expect.poll(capacity).toBe(advertised);
    expect(await limits()).toEqual({ [endpoint]: {} });

    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input) === '/api/config' && init?.method === 'PUT' && JSON.parse(init.body).openaiCompat?.contextWindows) {
          window.fetch = original;
          return Promise.resolve(new Response(JSON.stringify({error:'Fixture rejected limit'}), {status:409,headers:{'content-type':'application/json'}}));
        } return original(input, init);
      }; return true;
    })()`);
    await fill(field, String(override)); await click(save);
    await expect.poll(snapshot).toContain("Fixture rejected limit");
    expect(await limits()).toEqual({ [endpoint]: {} });
    await click(save);
    await expect.poll(capacity).toBe(override);

    const other = endpoint.replace("/v1", "/other/v1");
    await fill(en["keys.openaiCompat.url"], other);
    await evaluate(`(() => { const input = [...document.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === ${JSON.stringify(en["keys.openaiCompat.url"])}); input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true })); return true; })()`);
    await expect.poll(async () => (await request("/api/config")).openaiCompat.url).toBe(other);
    await request("/api/instances/openaiCompat/refresh-models", {});
    await expect.poll(capacity).toBe(32768);
    expect(await limits()).toEqual({ [endpoint]: { [model]: override } });
    await expect.poll(() => evaluate(`[...document.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === ${JSON.stringify(field)})?.value`)).toBe("");
    await fill(en["keys.openaiCompat.url"], endpoint);
    await evaluate(`document.querySelector('input[type=url]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); true`);
    await expect.poll(capacity).toBe(override);
    await expect.poll(() => evaluate(`[...document.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === ${JSON.stringify(field)})?.value`)).toBe(String(override));
    await expect.poll(snapshot).toContain(en["keys.openaiCompat.contextCurrent"].replace("{tokens}", override.toLocaleString("en-US")));
    const evidenceDir = join(ROOT, ".omb-scratch", "verification");
    mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = join(evidenceDir, "context-window-ui.json");
    writeFileSync(evidencePath, JSON.stringify({ logPath: info.logPath, advertised, override, saved: await limits(), snapshot: await snapshot() }, null, 2));
    await ui("screenshot", "--out", join(evidenceDir, "context-window-ui.png"));
    console.log({ evidencePath });
  } finally {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 900_000);
