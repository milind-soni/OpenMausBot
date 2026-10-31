// The MCP Settings Test reaches a URL server the way a bot's turn does. Where turns are boxed, a turn's engine never holds
// a server's headers: it asks the credential broker at a grant made for its conversation (server/bot-box/broker-mcp.ts),
// and the broker adds the headers and forwards. So the test asks the broker too, through its socket, with a grant made
// the same way and revoked as soon as the test ends. Where turns aren't boxed, bots and the test both go direct.
import { randomUUID } from "node:crypto";
import { Agent, fetch as fetchVia } from "undici";

import type { BoxBroker } from "./box.ts";
import { brokerUrl } from "./broker.ts";
import { mcpGrantName } from "./broker-mcp.ts";

export interface BrokerPath { broker: Pick<BoxBroker, "port" | "mintForThread" | "revokeThread">; socketPath: string }

/** A test's grant is gone well before this even if the test never ends. */
const PROBE_GRANT_TTL_MS = 2 * 60_000;
/** What the broker answers when the server's address didn't answer it, as a direct test sees a refused connection. */
const UNREACHED = new Set(['{"error":"upstream_unreachable"}', '{"error":"bad_upstream"}']);

/** The broker as a turn's engine reaches it, or null where turns aren't boxed and so reach servers directly. */
export function brokerPath(box: { broker(): BrokerPath["broker"] | null; brokerSocket(): string | null }): BrokerPath | null {
  const broker = box.broker(), socketPath = box.brokerSocket();
  return broker && socketPath ? { broker, socketPath } : null;
}

/** A short-lived grant for one server, as a turn gets one: the address and fetch to test it with, and `done` to revoke it. */
export function brokeredServer(path: BrokerPath, name: string, server: { url: string; headers: Record<string, string> }): { url: string; fetch: typeof fetch; done(): Promise<void> } {
  const threadId = `mcp-test-${randomUUID()}`;
  const grant = mcpGrantName(name);
  const { token } = path.broker.mintForThread({ threadId, grants: { [grant]: { upstream: server.url, headers: { ...server.headers } } }, ttlMs: PROBE_GRANT_TTL_MS });
  const agent = new Agent({ connect: { socketPath: path.socketPath } });
  const brokered: typeof fetch = async (input, init) => {
    const response = await fetchVia(String(input instanceof Request ? input.url : input), { ...init, dispatcher: agent } as Parameters<typeof fetchVia>[1]) as unknown as Response;
    if (response.status !== 502 || !(response.headers.get("content-type") ?? "").startsWith("application/json")) return response;
    const text = await response.text().catch(() => "");
    if (UNREACHED.has(text)) throw new TypeError("fetch failed");
    return new Response(text, { status: response.status, headers: response.headers });
  };
  return {
    url: brokerUrl(path.broker.port, token, grant),
    fetch: brokered,
    done: async () => {
      path.broker.revokeThread(threadId);
      await agent.close().catch(() => {});
    },
  };
}
