import { clientAddress } from "./client-address";
import { limitAction, limitReached } from "./server-store";
import { mcpClientExists } from "./mcp-oauth";

/** OAuth endpoints: per client address behind a trusted proxy; otherwise per registered client, plus one bucket for unknown ids. */
export async function limitOAuthEndpoint(request: Request, endpoint: string, clientId: string, maximum: number) {
  const address = clientAddress(request);
  if (address) return limitAction(`${endpoint}:ip:${address}`, maximum, 60000);
  if (await mcpClientExists(clientId)) return limitAction(`${endpoint}:client:${clientId}`, maximum, 60000);
  return limitAction(`${endpoint}:unknown-client`, maximum * 3, 60000);
}

// Failed MCP authentication: per client address behind a trusted proxy, otherwise one bucket for the endpoint.
const FAILURES_PER_ADDRESS = 20, FAILURES_TOTAL = 120;
const failureKey = (request: Request) => {
  const address = clientAddress(request);
  return address ? { key: `mcp-auth-fail:ip:${address}`, maximum: FAILURES_PER_ADDRESS } : { key: "mcp-auth-fail", maximum: FAILURES_TOTAL };
};
export function mcpAuthBlocked(request: Request) {
  const { key, maximum } = failureKey(request);
  return limitReached(key, maximum);
}
export async function recordMcpAuthFailure(request: Request) {
  const { key, maximum } = failureKey(request);
  try { await limitAction(key, maximum, 60000); } catch { /* already over the limit, or the store is unavailable */ }
}
