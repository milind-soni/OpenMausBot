#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("2.1.300"); process.exit(0); }
if (argv.includes("--help")) { console.log("--autocompact"); process.exit(0); }
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const hidden = () => !existsSync(`${process.env.OMB_BOX_TEST_DATA}/messages.db`);
const argument = (name: string) => argv[argv.indexOf(name) + 1]!;

if (process.env.OMB_BOX_TEST_ENGINE === "claude") {
  createInterface({ input: process.stdin }).on("line", async () => {
    const server = JSON.parse(readFileSync(argument("--mcp-config"), "utf8")).mcpServers.ogb;
    const proxy = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
    try {
      const reply = new Promise<any>((resolve, reject) => {
        proxy.once("error", reject);
        createInterface({ input: proxy.stdout }).once("line", (line) => resolve(JSON.parse(line)));
      });
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "echo fixture" } } } }) + "\n");
      const answer = await reply;
      let token: string | null = null, tokenWritable = false, socketChmodError: string | null = null;
      try { chmodSync(server.args.at(-1), 0o666); } catch (error) { socketChmodError = (error as NodeJS.ErrnoException).code ?? String(error); }
      try { token = readFileSync(process.env.OMB_HOOK_TOKEN_FILE!, "utf8"); } catch {}
      try { writeFileSync(process.env.OMB_HOOK_TOKEN_FILE!, "changed"); tokenWritable = true; } catch {}
      const result = { permission: JSON.parse(answer.result.content[0].text).behavior, socket: server.args.at(-1), pid: process.pid, token, tokenWritable, socketChmodError, hidden: hidden(), otherTokenHidden: !existsSync(process.env.OMB_BOX_TEST_OTHER_TOKEN!) };
      send({ type: "system", subtype: "init", session_id: "fixture", tools: [] });
      send({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      send({ type: "result", is_error: false, total_cost_usd: 0, stop_reason: "end_turn" });
    } finally { proxy.kill(); }
  });
} else {
  let config: any;
  try {
    if (process.env.OMB_MCP_CONFIG) {
      config = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8"));
      const extension = await import("../drivers/pi-mcp-extension.ts");
      let tools = ["read", "bash"];
      const handlers = new Map<string, () => unknown>();
      await extension.default({ registerTool: () => {}, on: (event, handler) => { handlers.set(event, handler); }, getActiveTools: () => tools, setActiveTools: (selected) => { tools = selected; } });
      handlers.get("session_start")?.();
    }
  } catch (error) { process.stderr.write(String(error) + "\n"); }
  createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "get_available_models") send({ type: "response", command: cmd.type, success: true, data: { models: [] } });
    else if (cmd.type === "get_state") send({ type: "response", command: cmd.type, success: true, data: {} });
    else if (cmd.type === "prompt") {
      let configWriteError: string | null = null;
      const configBefore = readFileSync(process.env.OMB_MCP_CONFIG!, "utf8");
      try { writeFileSync(process.env.OMB_MCP_CONFIG!, "overwritten"); } catch (error) { configWriteError = (error as NodeJS.ErrnoException).code ?? String(error); }
      const configUnchanged = readFileSync(process.env.OMB_MCP_CONFIG!, "utf8") === configBefore;
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ config: Boolean(config), configWriteError, configUnchanged, hidden: hidden() }) } });
      send({ type: "turn_end", message: { stopReason: "end_turn" } });
      send({ type: "agent_end", messages: [] });
      send({ type: "agent_settled" });
    } else send({ type: "response", command: cmd.type, success: true, data: {} });
  });
}
