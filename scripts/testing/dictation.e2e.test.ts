import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

describe("dictation in the isolated real browser", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("retains utterances and stops capture when the send arrow is clicked", async () => {
    let output = "";
    let errors = "";
    let info: { ui: string; url: string; botId: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(root, "scripts/control-omb.ts"), "ui", "launch", "--entry", "dictation"], {
      cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { errors += String(chunk); });
    child.on("error", error => { errors += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const input = () => evaluate('document.querySelector("textarea")?.value');
    const button = (label: string) => evaluate(`Boolean(document.querySelector('button[aria-label="${label}"]'))`);
    const click = (label: string) => ui("click", "--name", label);
    await expect.poll(() => button("Start dictation"), { timeout: 20_000 }).toBe(true);
    await click("Start dictation");
    await evaluate('window.dictationFixture.hear({text:"架空の一文目。",partial:true,utteranceFinal:true,speechStart:0}); true');
    await expect.poll(input).toBe("架空の一文目。");
    await evaluate('window.dictationFixture.hear({text:"架空の二文目。",partial:true,utteranceFinal:true,speechStart:5}); true');
    await expect.poll(input).toBe("架空の一文目。 架空の二文目。");
    await evaluate('window.dictationFixture.hear({text:"",partial:true}); true');
    expect(await input()).toBe("架空の一文目。 架空の二文目。");
    expect(await button("Stop dictation")).toBe(true);
    await click("Send message");
    await expect.poll(input).toBe("");
    expect((await evaluate("window.dictationFixture.stats()")).capturing).toBe(false);
    await evaluate('window.dictationFixture.late("架空の一文目。 架空の二文目。"); window.dictationFixture.hear({text:"送信後の独り言。",partial:true}); true');
    expect(await input()).toBe("");
    await expect.poll(async () => {
      const result = await runControlOmb(["messages", "--url", info.url, "--bot", info.botId]) as { messages: Array<{ role: string; text?: string }> };
      return result.messages.filter(message => message.role === "user").map(message => message.text);
    }, { timeout: 20_000 }).toEqual(["架空の一文目。 架空の二文目。"]);
  }, 240_000);
});
