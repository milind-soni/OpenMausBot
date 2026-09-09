// Exercise the harness caller that constructs browser integrations: a direct
// driver test would miss a browser MCP environment replacing its augmented PATH.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// This regression concerns Unix shebang lookup and macOS Finder's PATH;
// Windows resolves CLI shims through a separate launch contract.
describe.skipIf(process.platform === "win32")("Codex browser turns with a minimal GUI PATH", () => {
  let home: string;
  let bin: string;
  let browser: string;
  let base: string;
  let child: ChildProcess;
  let events: SseRecorder;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-browser-codex-path-"));
    bin = join(home, ".local", "bin");
    const data = join(home, ".openmausbot");
    mkdirSync(bin, { recursive: true });
    mkdirSync(data);
    // The extensionless executable must exercise /usr/bin/env node, rather
    // than the driver's explicit .ts-file launch through process.execPath.
    const codex = join(bin, "codex");
    writeFileSync(codex, '#!/usr/bin/env node\nimport("./fake-codex-app-server.mjs");\n', { mode: 0o755 });
    // A Linux system Node may precede our symlink; it need not support .ts.
    writeFileSync(join(bin, "fake-codex-app-server.mjs"), stripTypeScriptTypes(
      readFileSync(join(SERVER_DIR, "testing", "fake-codex-app-server.ts"), "utf8"),
    ));
    symlinkSync(process.execPath, join(bin, "node"));
    browser = join(bin, "agent-browser");
    // The fake provider records MCP configuration without starting a browser.
    // Preparation checks that the acknowledged close really removed it.
    writeFileSync(browser, "#!/bin/sh\nif [ \"$1\" = session ]; then printf '%s\\n' '{\"success\":true,\"data\":{\"sessions\":[]}}'; fi\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      features: { browser: true },
      instances: Object.fromEntries(["default", "absolute"].map((id) => [id, {
        driver: "codex",
        environment: { FAKE_CODEX_DUMP: join(home, `${id}.json`) },
        config: { cli: id === "default" ? "codex" : codex },
      }])),
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: FINDER_PATH, HOME: home, OMB_DATA_DIR: data, OMB_PORT: String(port),
        OMB_AGENT_BROWSER_PATH: browser, VITEST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Fixture did not listen: ${stderr}`)), 25_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Fixture exited: ${stderr}`)); });
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        if (output.includes(`openmausbot server on ${base}`)) { clearTimeout(timer); resolve(); }
      });
    });
    events = await openSse(`${base}/api/events`);
  }, 30_000);

  afterAll(async () => {
    events?.close();
    await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it.each(["default", "absolute"])("keeps the browser mounted and completes a turn with the %s Codex CLI", async (instanceId) => {
    const created = await api("POST", "/api/bots", {
      name: `Browser PATH ${instanceId}`, browser: true,
      modelSelection: { instanceId, model: "gpt-fake-default" },
    });
    expect(created.status).toBe(201);
    const botId = created.body.bot.id;
    const since = events.frames.length;
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "Check the browser integration." })).status).toBe(202);
    const started = await events.until((frame) => events.frames.indexOf(frame) >= since && frame.kind === "bot" && frame.bot?.id === botId && frame.bot?.busy === true);
    // The creation's idle event can arrive after its HTTP response. Only
    // accept an idle event ordered after this turn became busy.
    await events.until((frame) => events.frames.indexOf(frame) > events.frames.indexOf(started) && frame.kind === "bot" && frame.bot?.id === botId && frame.bot?.busy === false);
    const bot = (await api("GET", "/api/bots")).body.bots.find((item: any) => item.id === botId);
    const replies = bot.messages.filter((message: any) => message.role === "bot").map((message: any) => message.text);
    expect(replies, JSON.stringify(replies)).toContain("done from fake codex");
    const dump = JSON.parse(readFileSync(join(home, `${instanceId}.json`), "utf8"));
    // Linux may provide /usr/bin/node, so completion alone cannot prove the
    // absolute CLI retained access to the user's discovered runtime directory.
    expect(dump.env.PATH.split(":")).toContain(bin);
    expect(dump.env.PATH).toContain(FINDER_PATH);
    // Browser work now passes through the turn-scoped hold gate. The Codex
    // process receives no shared profile key or direct browser command.
    expect(dump.argv).toContain(`mcp_servers.browser.command=${JSON.stringify(process.execPath)}`);
    expect(dump.argv.some((arg: string) => arg.startsWith("mcp_servers.browser.args=") && arg.includes("browser-proxy.ts"))).toBe(true);
    expect(dump.env.OMB_BROWSER_TOKEN).toBeTruthy();
    expect(dump.env.AGENT_BROWSER_SESSION).toBeUndefined();
    expect(dump.env.AGENT_BROWSER_ENCRYPTION_KEY).toBeUndefined();
    expect(dump.calls.some((call: any) => call.method === "turn/start")).toBe(true);
  });
});
