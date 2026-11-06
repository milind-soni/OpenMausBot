// A restarted command server keeps a Codex bot's turns running, on a real server with the fake Codex CLI. Nothing here
// reaches the user's data or port 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { workerPort } from "./testing/worker-port.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeCodex = join(root, "server", "testing", "fake-codex-app-server.ts");
const fakeMcp = join(root, "server", "testing", "fake-mcp-server.ts");
const port = workerPort(19400, 10_000);
const base = `http://127.0.0.1:${port}`;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", origin: base },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};

it("a Codex bot's next turn runs after its command server is turned off and on", async () => {
  chmodSync(fakeCodex, 0o755);
  const home = mkdtempSync(join(tmpdir(), "omb-mcp-restart-codex-"));
  const dump = join(home, "codex-dump.json");
  mkdirSync(join(home, ".openmausbot"));
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: { codex: { driver: "codex", environment: { FAKE_CODEX_DUMP: dump, FAKE_CODEX_DUMP_TURNS_ONLY: "1" }, config: { cli: fakeCodex } } },
    mcpServers: { notes: { command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", fakeMcp], env: { NOTES_KEY: "kept" }, enabled: true } },
  }));
  const child: ChildProcess = spawn(process.execPath, [join(root, "server", "index.ts")], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, OMB_PORT: String(port) }, stdio: "ignore",
  });
  try {
    await expect.poll(() => fetch(`${base}/api/health`).then((response) => response.ok, () => false), { timeout: 30_000 }).toBe(true);
    const bot = (await api("POST", "/api/bots", {})).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "codex", model: "fake-model" }, mcpServers: ["notes"] })).status).toBe(200);
    const replies = async () => (await api("GET", "/api/bots")).body.bots.find((one: any) => one.id === bot.id);
    const turn = async (text: string, count: number) => {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
      await expect.poll(async () => {
        const current = await replies();
        return !current.busy && current.messages.filter((message: any) => message.kind === "text" && message.text === "done from fake codex").length;
      }, { timeout: 30_000 }).toBe(count);
      return JSON.parse(readFileSync(dump, "utf8"));
    };

    expect((await turn("before the restart", 1)).argv).toContain('mcp_servers.notes.env_vars=["NOTES_KEY"]');
    expect((await api("PATCH", "/api/mcp/servers/notes", { enabled: false })).status).toBe(200);
    expect((await api("PATCH", "/api/mcp/servers/notes", { enabled: true })).status).toBe(200);
    const after = await turn("after the restart", 2);
    expect(after.argv).toContain('mcp_servers.notes.env_vars=["NOTES_KEY"]');
    expect(after.env.OMB_MCP_RESTART).toBeUndefined();
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, hostTimeout(90_000));
