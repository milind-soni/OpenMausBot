import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import bridgedAgents from "../drivers/agents-catalog-goldens/bridged.tools-list.json" with { type: "json" };
import fullAgents from "../drivers/agents-catalog-goldens/full.tools-list.json" with { type: "json" };
import { spawnCli } from "../procs.ts";
import { nativeFixture } from "./antigravity-native-fixture.ts";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { droppedTools, ServerNames } from "./fake-antigravity-mcp.ts";

const FAKE_MCP = join(dirname(fileURLToPath(import.meta.url)), "fake-mcp-server.ts");
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "fake-antigravity-cli.ts");

describe("the fake native CLI's tool budget", () => {
  const servers = (agents: readonly { name: string }[]) => [
    { name: "agents", tools: agents }, { name: "browser", tools: BROWSER_TOOLS }, { name: "data", tools: DATA_TOOLS },
  ];

  it("drops the largest agents tools, coordinate_bots among them, from the full list beside browser and data", () => {
    const dropped = droppedTools(servers(fullAgents.tools));
    expect(dropped).toContain("agents/coordinate_bots");
    expect(dropped).toContain("agents/trigger");
  });

  it("keeps every tool of the bridged list beside browser and data", () => {
    expect([...droppedTools(servers(bridgedAgents.tools))]).toEqual([]);
  });

  it("renames a server registered again in one process with another environment", () => {
    const names = new ServerNames();
    const server = { name: "agents", command: "node", args: ["proxy.js"], env: [{ name: "BRIDGE", value: "0" }] };
    expect(names.nameFor(server)).toBe("agents");
    expect(names.nameFor(server)).toBe("agents");
    expect(names.nameFor({ ...server, env: [{ name: "BRIDGE", value: "1" }] })).toMatch(/^agents_[0-9a-f]{8}$/u);
  });
});

type Message = { id?: unknown; method?: string; params?: any; result?: any; error?: any };

function acpClient(profile: string, env: Record<string, string>) {
  const child = spawnCli(process.execPath, [FAKE_CLI, "acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const waiting = new Map<unknown, (message: Message) => void>();
  const seen: Message[] = [];
  let answer: (message: Message) => unknown = () => undefined;
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    seen.push(message);
    if (message.method === "session/request_permission") {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message) })}\n`);
      return;
    }
    const wait = waiting.get(message.id);
    if (wait && !message.method) {
      waiting.delete(message.id);
      wait(message);
    }
  });
  const request = (method: string, params: unknown) => new Promise<Message>((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const text = (sessionId: string, from: number) => seen.slice(from)
    .filter((message) => message.method === "session/update" && message.params?.sessionId === sessionId && message.params.update.sessionUpdate === "agent_message_chunk")
    .map((message) => message.params.update.content.text).join("");
  return { child, request, seen, text, onPermission: (fn: (message: Message) => unknown) => { answer = fn; } };
}

describe("the fake native CLI's MCP turns", () => {
  const children: ReturnType<typeof spawnCli>[] = [];
  const folders: string[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill();
      await waitForExit(child);
    }
    for (const folder of folders.splice(0)) await removeTempDir(folder);
  });

  it("asks permission as 1.5.14 does, runs the tool once allowed, renames a changed server in one process and not after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fake-agy-mcp-"));
    folders.push(directory);
    const fixture = nativeFixture(join(directory, "bin"));
    const profile = join(directory, "profile");
    writeFileSync(join(directory, "token"), "");
    const env = { FAKE_AGY_LOG: fixture.log, FAKE_AGY_KEYRING: "", SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" };
    const signIn = acpClient(profile, env);
    children.push(signIn.child);
    await signIn.request("initialize", { protocolVersion: 1 });
    // The fake's sign-in file, written as `acp --login` would.
    const credential = join(profile, "antigravity-acp", "antigravity-oauth-token");
    (await import("node:fs")).mkdirSync(dirname(credential), { recursive: true });
    writeFileSync(credential, "{}");

    const callFile = join(directory, "call.json");
    const notes = (marker: string) => ({ name: "notes", command: process.execPath, args: [FAKE_MCP], env: [{ name: "FAKE_MCP_CALL_FILE", value: callFile }, { name: "MARK", value: marker }] });
    const created = await signIn.request("session/new", { cwd: directory, mcpServers: [notes("a")] });
    const sessionId = created.result.sessionId as string;
    expect(fixture.entries().find((entry) => entry.event === "tools")).toMatchObject({ visible: ["mcp_notes_read_notes"], hidden: [] });

    signIn.onPermission(() => ({ outcome: { outcome: "selected", optionId: "allow" } }));
    let from = signIn.seen.length;
    expect(await signIn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fake-agy: call notes/read_notes {\"page\":2}" }] })).toMatchObject({ result: { stopReason: "end_turn" } });
    const permission = signIn.seen.slice(from).find((message) => message.method === "session/request_permission")!;
    expect(permission.params).toMatchObject({
      toolCall: { name: "mcp_notes_read_notes", title: "Run mcp_notes_read_notes", kind: "other", rawInput: { page: 2, toolSummary: "Run read_notes" } },
      options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
    });
    expect(JSON.parse(readFileSync(callFile, "utf8"))).toMatchObject({ name: "read_notes", arguments: { page: 2 } });
    expect(signIn.text(sessionId, from)).toContain("RESULT notes/read_notes: Fixture notes read through MCP.");

    expect((await signIn.request("session/resume", { sessionId, cwd: directory, mcpServers: [notes("b")] })).error).toBeUndefined();
    from = signIn.seen.length;
    await signIn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fake-agy: tools" }] });
    expect(signIn.text(sessionId, from)).toMatch(/^TOOLS mcp_notes_[0-9a-f]{8}_read_notes\n$/u);

    signIn.child.kill();
    const restarted = acpClient(profile, env);
    children.push(restarted.child);
    await restarted.request("initialize", { protocolVersion: 1 });
    expect((await restarted.request("session/resume", { sessionId, cwd: directory, mcpServers: [notes("c")] })).error).toBeUndefined();
    from = restarted.seen.length;
    await restarted.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fake-agy: tools\nfake-agy: call notes/missing {}" }] });
    expect(restarted.text(sessionId, from)).toBe("TOOLS mcp_notes_read_notes\nNOTOOL notes/missing\n");
  }, 30_000);

  it("ends a turn whose session/cancel came before the cancelled answer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fake-agy-early-cancel-"));
    folders.push(directory);
    const fixture = nativeFixture(join(directory, "bin"));
    const profile = join(directory, "profile");
    const credential = join(profile, "antigravity-acp", "antigravity-oauth-token");
    (await import("node:fs")).mkdirSync(dirname(credential), { recursive: true });
    writeFileSync(credential, "{}");
    const client = acpClient(profile, { FAKE_AGY_LOG: fixture.log, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" });
    children.push(client.child);
    await client.request("initialize", { protocolVersion: 1 });
    const { result } = await client.request("session/new", { cwd: directory, mcpServers: [{ name: "notes", command: process.execPath, args: [FAKE_MCP], env: [] }] });
    client.onPermission(() => {
      client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: result.sessionId } })}\n`);
      return { outcome: { outcome: "cancelled" } };
    });
    expect(await client.request("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "fake-agy: call notes/read_notes {}" }] }))
      .toMatchObject({ result: { stopReason: "cancelled" } });
  }, 30_000);

  it("holds a turn whose permission was cancelled until session/cancel", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fake-agy-cancel-"));
    folders.push(directory);
    const fixture = nativeFixture(join(directory, "bin"));
    const profile = join(directory, "profile");
    const credential = join(profile, "antigravity-acp", "antigravity-oauth-token");
    (await import("node:fs")).mkdirSync(dirname(credential), { recursive: true });
    writeFileSync(credential, "{}");
    const client = acpClient(profile, { FAKE_AGY_LOG: fixture.log, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" });
    children.push(client.child);
    await client.request("initialize", { protocolVersion: 1 });
    const { result } = await client.request("session/new", { cwd: directory, mcpServers: [{ name: "notes", command: process.execPath, args: [FAKE_MCP], env: [] }] });
    client.onPermission(() => ({ outcome: { outcome: "cancelled" } }));
    let settled = false;
    const turn = client.request("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "fake-agy: call notes/read_notes {}" }] }).then((message) => { settled = true; return message; });
    for (let waited = 0; !fixture.entries().some((entry) => entry.event === "awaiting-cancel"); waited += 50) {
      if (waited > 10_000) throw new Error("the fake never began waiting for session/cancel");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(settled).toBe(false);
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: result.sessionId } })}\n`);
    expect(await turn).toMatchObject({ result: { stopReason: "cancelled" } });
  }, 30_000);
});
