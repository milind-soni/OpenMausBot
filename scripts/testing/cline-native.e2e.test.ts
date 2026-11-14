// Optional qualification of the installed CLI against a loopback provider.
// No real account, network provider, workspace or user settings are used.
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ClineAgentDriver } from "../../server/drivers/acp/cline.ts";
import { execCli } from "../../server/procs.ts";
import { recordEvents } from "../../server/testing/events.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import type { ProviderInstance } from "../../server/contracts.ts";

const cli = process.env.OMB_CLINE_NATIVE_PATH;
(cli ? it : it.skip)("runs the native Cline CLI with its saved custom model and provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-cline-native-"));
  const requests: Array<{ path: string; model?: string; tools?: string[] }> = [];
  const callFile = join(home, "mcp-call.json");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const input = body ? JSON.parse(body) : {};
    requests.push({ path: req.url!, model: input.model, tools: input.tools?.map((tool: any) => tool.function?.name) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = input.tools?.find((tool: any) => tool.function?.name?.includes("read_notes"))?.function?.name;
    const call = requests.length === 1 && tool;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-read", type: "function", function: { name: tool, arguments: "{}" } }] }
      : { role: "assistant", content: "Native Cline fixture completed." };
    for (const [part, finish] of [[delta, null], [{}, call ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model",
        choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  let instance: ProviderInstance | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8",
      CLINE_DATA_DIR: join(home, ".cline", "data"), XDG_CONFIG_HOME: join(home, ".config") };
    await new Promise<void>((resolve, reject) => execCli(cli!, ["auth", "--provider", "openai", "--apikey", "fixture-only-key",
      "--modelid", "fixture-model", "--baseurl", `http://127.0.0.1:${address.port}/v1`], { env, timeout: 15_000 },
    (error) => error ? reject(error) : resolve()));
    const path = join(env.CLINE_DATA_DIR, "settings", "providers.json");
    const before = readFileSync(path, "utf8");
    instance = await ClineAgentDriver.create({ instanceId: "native-cline", displayName: "Cline", enabled: true,
      environment: env, config: { cli: cli!, fullAuto: false } });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    const recorder = recordEvents(instance.adapter);
    instance.adapter.onEvent((event) => {
      // Only the disposable notes server can be approved in this recipe.
      if (event.type === "request.opened") void instance!.adapter.respondToRequest("native-fixture", event.requestId,
        { behavior: JSON.stringify(event).includes("read_notes") ? "allow" : "deny" });
    });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "native-fixture", cwd: home,
      text: "Read the fixture notes, then say Native Cline fixture completed.", model: "cline-default", approvalMode: "ask",
      integrations: { custom: { fixture: { command: process.execPath,
        args: ["--experimental-strip-types", fileURLToPath(new URL("../../server/testing/fake-mcp-server.ts", import.meta.url))], env: { FAKE_MCP_CALL_FILE: callFile } } } } });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 40_000)).toMatchObject({ ok: true });
    expect(recorder.events.some((event) => event.type === "content.delta" && event.delta.includes("Native Cline fixture completed"))).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.path === "/v1/chat/completions" && request.model === "fixture-model")).toBe(true);
    expect(requests[0].tools?.some((name) => name.includes("read_notes"))).toBe(true);
    expect(JSON.parse(readFileSync(callFile, "utf8"))).toMatchObject({ name: "read_notes", arguments: {} });
    expect(readFileSync(path, "utf8")).toBe(before);
    const evidence = join(process.cwd(), ".omb-scratch", "verify-evidence");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "cline-native.json"), JSON.stringify({ platform: process.platform, snapshot: await instance.snapshot(), requests }, null, 2));
    recorder.stop();
  } finally {
    await instance?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(home);
  }
}, 90_000);

(cli ? it : it.skip)("keeps native command execution behind approvals across Full and Ask turns", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-cline-native-permissions-"));
  let marker = "", calls = 0;
  const permissions: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const tool = input.tools?.find((entry: any) => entry.function?.name === "run_commands")?.function?.name;
    const call = ++calls === 1 && tool;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-command", type: "function", function: {
      name: tool, arguments: JSON.stringify({ commands: [`printf '%s' fixture > ${quote(marker)}`] }),
    } }] } : { role: "assistant", content: "Native permission fixture completed." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [part, finish] of [[delta, null], [{}, call ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model",
        choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  let instance: ProviderInstance | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8",
      CLINE_DATA_DIR: join(home, ".cline", "data"), XDG_CONFIG_HOME: join(home, ".config") };
    await new Promise<void>((resolve, reject) => execCli(cli!, ["auth", "--provider", "openai", "--apikey", "fixture-only-key",
      "--modelid", "fixture-model", "--baseurl", `http://127.0.0.1:${address.port}/v1`], { env, timeout: 15_000 },
    error => error ? reject(error) : resolve()));
    instance = await ClineAgentDriver.create({ instanceId: "native-permissions", displayName: "Cline", enabled: true,
      environment: env, config: { cli: cli!, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    let mode: "ask" | "full" = "ask";
    instance.adapter.onEvent(event => {
      if (event.type !== "request.opened") return;
      permissions.push(mode);
      // The harness applies the current policy to this canonical request. This
      // recipe permits only a harmless marker in the owned temporary directory.
      void instance!.adapter.respondToRequest("native-permissions", event.requestId, { behavior: mode === "full" ? "allow" : "deny" });
    });
    for (const [index, policy] of (["ask", "full", "ask"] as const).entries()) {
      mode = policy;
      marker = join(home, `command-${index}.txt`);
      calls = 0;
      const { turnId } = await instance.adapter.sendTurn({ threadId: "native-permissions", cwd: home,
        text: `Run the fixture command for ${index}, then say Native permission fixture completed.`,
        model: "cline-default", approvalMode: mode });
      const completed = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 40_000);
      if (mode === "full") expect(completed).toMatchObject({ ok: true });
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(existsSync(marker)).toBe(mode === "full");
      if (mode === "full") expect(readFileSync(marker, "utf8")).toBe("fixture");
    }
    expect(permissions).toEqual(["ask", "full", "ask"]);
    const evidence = join(process.cwd(), ".omb-scratch", "verify-evidence");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "cline-native-permissions.json"), JSON.stringify({ platform: process.platform,
      version: (await instance.snapshot()).version, permissions, executed: [false, true, false] }, null, 2));
    recorder.stop();
  } finally {
    await instance?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeTempDir(home);
  }
}, 150_000);
