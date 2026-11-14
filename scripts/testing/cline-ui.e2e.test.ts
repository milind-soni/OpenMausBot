// Real model picker and chat transport against disposable provider CLIs.
import { expect, it } from "vitest";
import { closeBrowserSession } from "../../server/browser-engine.ts";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./control-omb-ui.ts";
import { mountPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1";

(enabled ? it : it.skip)("selects the configured Cline model in both picker modes and sends a specialist turn", async () => {
  const tools = await ensureUiBrowser();
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["cline"]);
  let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
  const env = sessionEnv({ home: fixture.info.dataDir, session: `omb-cline-ui-${new URL(fixture.info.url).port}`, chrome: tools.chrome });
  const browser = (...args: string[]) => agentBrowser(tools.binary, env, args);
  const evaluate = async (js: string) => (await browser("eval", js)).result;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    let clineName = "";
    await expect.poll(async () => {
      const { instances } = await fetch(`${fixture.info.url}/api/instances`).then(response => response.json());
      const cline = instances.find((entry: any) => entry.instanceId === "cline");
      clineName = cline?.displayName ?? "";
      return cline?.snapshot;
    }, { timeout: 15_000 }).toEqual(expect.objectContaining({ state: "available", authenticated: true }));
    const bot = (await cli("new-bot", "--name", "Cline specialist")).bot;
    preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__cline.html", title: "Cline verification", logLevel: "warn" });
    await browser("open", preview.previewUrl);
    for (const advanced of [false, true]) {
      await evaluate(`localStorage.setItem('omb-advanced-mode', '${advanced ? "1" : "0"}'); location.reload(); true`);
      await expect.poll(() => evaluate("document.querySelector('textarea[aria-label=\"Message Cline specialist\"]') !== null"), { timeout: 15_000 }).toBe(true);
      await evaluate("document.querySelector('button[data-tour=\"model\"]').click(); true");
      await expect.poll(() => evaluate("document.querySelector('[data-model-picker-content]') !== null")).toBe(true);
      const provider = `[...document.querySelectorAll('[data-model-picker-content] button')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(clineName)} || button.textContent.trim().endsWith(${JSON.stringify(clineName)}))`;
      await expect.poll(() => evaluate(`${provider} !== undefined`), { timeout: 15_000, message: `Cline provider in ${advanced ? "Advanced" : "Simple"} picker` }).toBe(true);
      await evaluate(`${provider}.click(); true`);
      const model = "[...document.querySelectorAll('[data-model-picker-content] button')].find(button => button.textContent.includes('Cline default (configured)') && !button.hasAttribute('data-follow-bot-model'))";
      await expect.poll(() => evaluate(`${model}?.textContent ?? ''`), { timeout: 15_000 }).toContain("Cline default (configured)");
      expect(await evaluate("document.querySelector('[data-model-picker-content]').textContent")).not.toContain("Run this agent with a model already on your machine.");
      await browser("screenshot", `${fixture.info.logPath}.cline-picker-${advanced ? "advanced" : "simple"}.png`);
      await evaluate(`${model}.click(); true`);
      await expect.poll(async () => {
        const bots = await fetch(`${fixture.info.url}/api/bots`).then(response => response.json());
        const current = bots.bots.find((entry: any) => entry.id === bot.id);
        return current?.tasks.find((task: any) => task.threadId === bot.activeTaskId)?.modelSelection ?? current?.modelSelection;
      }).toEqual(expect.objectContaining({ instanceId: "cline", model: "cline-default" }));
    }
    await browser("find", "role", "textbox", "fill", "Hello from the selected Cline engine", "--name", "Message Cline specialist", "--exact");
    await browser("press", "Enter");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "25")).status).toBe("settled");
    await expect.poll(async () => {
      const { messages } = await fetch(`${fixture.info.url}/api/threads/${bot.activeTaskId}/messages?limit=50`).then(response => response.json());
      return messages.some((message: any) => message.role === "bot" && message.text?.includes("hello from fake acp"));
    }, { timeout: 15_000 }).toBe(true);
    expect((await browser("console")).messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "error" })]));
  } finally {
    await closeBrowserSession(tools.binary, env);
    await preview?.close();
    await fixture.close();
  }
}, 180_000);
