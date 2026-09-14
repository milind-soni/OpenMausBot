// Harness-mounted tool executors for API-driven engines.
//
// CLI engines (Claude, Codex, ACP, pi) mount `turn.integrations.*` MCP
// servers inside their own agent process. API engines have no agent process
// — the harness is the MCP host instead: this module spawns each mounted
// integration's stdio MCP server, advertises its tools on the turn, and
// executes calls through server/mcp-stdio-client.ts. The OpenAI-compatible
// tool loop in the shared runtime consumes the result.
//
// Approval semantics are preserved exactly as for CLI engines: the mounted
// local-computer descriptor is the gated proxy (gatedLocalComputer), whose
// who-is-driving gate already answers tool calls with a refusal while the
// person holds control. Browser mounts ride the app's own browser proxy.
//
// Spawn failures degrade one server at a time: a computer mount that cannot
// start removes only its own tools and reports through toolListProblems, so
// a broken browser never silently disables the computer too — the model is
// told what actually mounted.
import { McpStdioClient } from "./mcp-stdio-client.ts";
import type { RuntimeTool } from "./contracts.ts";

/** The integration descriptors startTurn may mount for an API engine. */
export type ApiToolboxIntegrations = {
  localComputer?: { command: string; args: string[]; env: Record<string, string> };
  browser?: { command: string; args: string[]; env: Record<string, string> };
  phone?: { command: string; args: string[]; env: Record<string, string> };
  agents?: { command: string; args: string[]; env: Record<string, string> };
  composio?: { command: string; args: string[]; env: Record<string, string> };
  custom?: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
};

export interface ApiToolbox {
  tools: RuntimeTool[];
  /** Why a mounted integration contributed no tools (spawn/handshake/list). */
  toolListProblems: string[];
  close(): Promise<void>;
}

const MAX_TOOLS_PER_TURN = 64;

export async function buildApiToolbox(integrations: ApiToolboxIntegrations): Promise<ApiToolbox> {
  const clients: Array<{ label: string; client: McpStdioClient }> = [];
  const tools: RuntimeTool[] = [];
  const toolListProblems: string[] = [];

  const mounts: Array<{ label: string; spec: { command: string; args: string[]; env?: Record<string, string> } | undefined }> = [
    { label: "computer", spec: integrations.localComputer },
    { label: "browser", spec: integrations.browser },
    { label: "phone", spec: integrations.phone },
    { label: "agents", spec: integrations.agents },
    { label: "composio", spec: integrations.composio },
    ...Object.entries(integrations.custom ?? {}).map(([name, spec]) => ({ label: `mcp:${name}`, spec })),
  ];

  for (const { label, spec } of mounts) {
    if (!spec || tools.length >= MAX_TOOLS_PER_TURN) continue;
    try {
      const client = await McpStdioClient.start(spec);
      const listed = await client.listTools();
      if (listed.length === 0) {
        await client.close().catch(() => {});
        toolListProblems.push(`${label}: mounted but exposed no tools`);
        continue;
      }
      clients.push({ label, client });
      for (const tool of listed) {
        if (tools.length >= MAX_TOOLS_PER_TURN) break;
        tools.push({
          name: tool.name,
          description: tool.description,
          execute: async (args) => {
            try {
              return await client.callTool(tool.name, args);
            } catch (error) {
              return {
                isError: true,
                text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
                images: [],
              };
            }
          },
        });
      }
    } catch (error) {
      toolListProblems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    tools,
    toolListProblems,
    close: async () => {
      for (const { client } of clients) await client.close().catch(() => {});
    },
  };
}
