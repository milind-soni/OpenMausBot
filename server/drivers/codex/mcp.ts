// MCP server mounting for the codex app-server: -c overrides, credential
// placement, and the one-time SSE transport warning.
import type { McpServerSpec } from "../../contracts.ts";

const skippedSseServers = new Set<string>();

export function noteSkippedSseServer(name: string): void {
  if (skippedSseServers.has(name)) return;
  skippedSseServers.add(name);
  console.error(`codex: MCP server ${JSON.stringify(name)} uses the SSE transport, which codex does not speak — it is available to Claude bots only`);
}

/** A TOML inline table for a `-c key=value` override; JSON string quoting
 * is valid TOML basic-string quoting. */
function tomlInlineTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }`;
}

export function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: McpServerSpec,
  preApproved = true,
): void {
  const prefix = `mcp_servers.${name}`;
  if ("url" in server) {
    // A remote server: codex connects itself. Header values are credentials
    // (Authorization: Bearer …) and travel like env values — the child env
    // holds them under harness-generated names, argv names only the variables.
    // A bearer token goes through codex's own bearer setting, the path its
    // remote servers are documented and exercised with; any other header
    // rides env_http_headers.
    appServerArgs.push("-c", `${prefix}.url=${JSON.stringify(server.url)}`);
    const stem = `OMB_MCP_HEADER_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const variables: Record<string, string> = {};
    Object.entries(server.headers).forEach(([header, value], index) => {
      const bearer = header.toLowerCase() === "authorization" ? /^Bearer\s+(\S+)$/i.exec(value) : null;
      if (bearer) {
        env[`${stem}_BEARER`] = bearer[1];
        appServerArgs.push("-c", `${prefix}.bearer_token_env_var=${JSON.stringify(`${stem}_BEARER`)}`);
        return;
      }
      const variable = `${stem}_${index}`;
      env[variable] = value;
      variables[header] = variable;
    });
    if (Object.keys(variables).length) {
      appServerArgs.push("-c", `${prefix}.env_http_headers=${tomlInlineTable(variables)}`);
    }
  } else {
    Object.assign(env, server.env);
    appServerArgs.push(
      "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
      "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
      // Values stay in the child environment; argv contains names only so
      // credentials never appear in process listings or diagnostics.
      "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
    );
  }
  // Harness-owned servers are pre-quieted; a user-configured server keeps
  // codex's on-request policy so its tool calls become approval cards.
  if (preApproved) {
    appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="auto"`);
  }
}
