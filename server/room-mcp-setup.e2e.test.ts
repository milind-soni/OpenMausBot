import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { McpOAuthStore } from "./mcp-oauth-store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

it.skipIf(process.platform === "win32")("records a failed room turn when MCP configuration changes during OAuth refresh", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-room-mcp-"));
  let child: ChildProcess | undefined, refresh: ServerResponse | undefined, stderr = "";
  const oauth = createServer((req, res) => {
    if (req.url === "/token") refresh = res;
    else res.writeHead(404).end();
  });
  const release = () => refresh?.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ access_token: "fixture-refreshed", token_type: "Bearer", expires_in: 3600 }));
  try {
    await new Promise<void>((resolve) => oauth.listen(0, "127.0.0.1", resolve));
    const oauthUrl = `http://127.0.0.1:${(oauth.address() as { port: number }).port}`;
    const port = await freePortBlock([0, 1]), url = `http://127.0.0.1:${port}`;
    mkdirSync(join(dataDir, "tmp"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: { claude: { driver: "claudeAgent", displayName: "MCP fixture",
        config: { cli: fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url)) } } },
      mcpServers: { slow: { type: "http", url: `${oauthUrl}/mcp`, headers: {}, enabled: true, apps: false } },
    }));
    new McpOAuthStore(join(dataDir, "mcp-oauth.json")).put("slow", { url: `${oauthUrl}/mcp`, state: "signed-in", clientId: "fixture",
      tokenEndpoint: `${oauthUrl}/token`, tokens: { access: "fixture-expired", refresh: "fixture-refresh", expiresAt: 1 } });
    child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./testing/mcp-room-fixture.ts", import.meta.url))], {
      env: verificationServerEnvironment(process.env, dataDir, port), stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    await expect.poll(async () => {
      if (child!.exitCode !== null) throw new Error(stderr);
      try { return (await fetch(`${url}/api/health`)).status; } catch { return 0; }
    }, { timeout: 20_000 }).toBe(200);
    const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
    const { bot } = await control("new-bot", "--name", "MCP fixture") as { bot: { id: string } };
    const { channel } = await control("new-channel", "--name", "MCP room", "--members", bot.id) as { channel: { id: string } };
    await control("send-channel", "--channel", channel.id, "--text", "Reply once.");
    await expect.poll(() => Boolean(refresh), { timeout: 10_000 }).toBe(true);
    const disabled = await fetch(`${url}/api/mcp/servers/slow`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(disabled.status).toBe(200);
    release();
    await control("wait", "--channel", channel.id, "--timeout", "10");
    const transcript = await control("messages", "--channel", channel.id, "--limit", "20") as { messages: Array<{ kind: string; from?: { botId: string }; tool?: { name: string; ok: boolean } }> };
    expect(transcript.messages).toContainEqual(expect.objectContaining({
      kind: "activity", from: expect.objectContaining({ botId: bot.id }),
      tool: expect.objectContaining({ ok: false, name: expect.stringContaining("MCP configuration changed while preparing this turn") }),
    }));
    expect(existsSync(join(dataDir, "fake-claude-dump.json"))).toBe(false);
  } finally {
    if (refresh && !refresh.writableEnded) release();
    await waitForExit(child, { signal: "SIGTERM" });
    oauth.closeAllConnections();
    await new Promise<void>((resolve) => oauth.close(() => resolve()));
    await removeTempDir(dataDir);
  }
}, 45_000);
