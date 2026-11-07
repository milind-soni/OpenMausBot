import { createMcpDoor } from "./device-mcp.mjs";
import { ownPorts } from "./lent-mcp.mjs";

/** The computer-sharing option that gives each Cloud its door onto this computer's MCP servers. `sharing` is read when a
 * door is made, as the controller is built after these options; `door` goes to `createMcpDoor` as given. */
export function lentMcpOptions({ sharing, prompt, serverPorts, ...door }) {
  return {
    // Security: a lent MCP server is never pointed at this app's own server or Chrome's DevTools.
    mcp: (env, definition) => createMcpDoor({ approvals: sharing().mcpApprovals, prompt, ownPorts: () => ownPorts({ serverPorts: serverPorts() }), definition, ...door }),
  };
}
