import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { launchVerificationServer, runControlOmb } from "../control-omb.ts";
import { ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1" || !!resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
if (!enabled) console.info("skipping stream-buffer e2e: no agent-browser resolves; set OMB_UI_E2E=1 to install the pinned tools");
const execFileAsync = promisify(execFile);

it.skipIf(!enabled)("drains pending text and reasoning with rAF paused, then settles without duplicated output", async () => {
  const { binary, chrome } = await ensureUiBrowser();
  const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath: binary, executablePath: chrome ?? "" });
  const env = sessionEnv({ home: fixture.info.dataDir, session: `omb-stream-${new URL(fixture.info.url).port}`, chrome });
  const browser = async (...args: string[]) => {
    const { stdout } = await execFileAsync(binary, [...args, "--json"], { env, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 });
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    return result.data;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let preview: MountedPreview | undefined;
  try {
    const wrapper = join(fixture.info.dataDir, "gated-stream.mjs");
    const gate = join(fixture.info.dataDir, "settle.gate");
    // The existing fake CLI emits both delta channels. Hold only its final
    // frames until the browser has observed the intermediate renderer state.
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      "import { existsSync } from 'node:fs';",
      "if (process.argv.includes('--input-format')) {",
      "process.env.FAKE_CLAUDE_MODE = 'stream';",
      "process.env.FAKE_CLAUDE_TOOL_CALLS = '[]';",
      "const write = process.stdout.write.bind(process.stdout);",
      "const pending = []; let held = false;",
      "process.stdout.write = (chunk) => {",
      "const frame = JSON.parse(String(chunk));",
      "if (held || frame.type === 'assistant') { held = true; pending.push(chunk); return true; }",
      "return write(chunk); };",
      `const timer = setInterval(() => { if (!existsSync(${JSON.stringify(gate)})) return;`,
      "clearInterval(timer); process.stdout.write = write; for (const chunk of pending) write(chunk); }, 10);",
      "}",
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    const created = await control("new-bot", "--name", "Stream fixture");
    const target = ["--bot", created.bot.id, "--task", created.bot.activeTaskId];
    preview = await mountPreview(fixture, {
      entry: "/scripts/testing/stream-buffer-preview.tsx", route: "/__stream-buffer.html",
      title: "Isolated stream buffer", logLevel: "warn",
    });
    await browser("open", preview.previewUrl);
    await browser("wait", "--fn", "document.querySelector('#ready')?.textContent === 'true'");
    const before = await browser("eval", "JSON.parse(document.querySelector('#messages').textContent)");
    const finalMessages = [...before.result, "hello from fake claude"];
    await browser("eval", "window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {};");
    await control("send", ...target, "--text", "Show the whole reply");
    await browser("wait", "--fn", "document.querySelector('#text').textContent === 'hello from fake claude' && document.querySelector('#reasoning').textContent === 'hmm'");
    const read = () => browser("eval", "({text: document.querySelector('#text').textContent, reasoning: document.querySelector('#reasoning').textContent, messages: JSON.parse(document.querySelector('#messages').textContent)})");
    const intermediate = await read();
    evidence.push({ intermediate });
    expect(intermediate.result).toEqual({ text: "hello from fake claude", reasoning: "hmm", messages: before.result });
    writeFileSync(gate, "settle");
    const settled = await control("wait", ...target, "--timeout", "15");
    expect(settled.status).toBe("settled");
    await browser("wait", "--fn", `document.querySelector('#messages').textContent === ${JSON.stringify(JSON.stringify(finalMessages))} && document.querySelector('#text').textContent === '' && document.querySelector('#reasoning').textContent === ''`);
    // Wait past the fallback timer: no cleared delta may reappear afterward.
    await browser("eval", "new Promise(resolve => setTimeout(resolve, 250))");
    const final = await read();
    evidence.push({ settled, final, messages: await control("messages", ...target, "--limit", "10") });
    expect(final.result).toEqual({ text: "", reasoning: "", messages: finalMessages });
    const logs = await browser("console");
    expect(logs.messages.filter((message: { type: string }) => message.type === "error")).toEqual([]);
  } finally {
    let browserClosed = false;
    try { browserClosed = await closeBrowserSession(binary, env); }
    finally {
      try { await preview?.close(); }
      finally { await fixture.close(); }
    }
    expect(browserClosed).toBe(true);
    expect(existsSync(fixture.info.dataDir)).toBe(false);
    const evidencePath = `${fixture.info.logPath}.stream.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, serverPid: fixture.info.pid, dataRemoved: true }));
  }
}, 120_000);
