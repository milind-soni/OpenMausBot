// A URL MCP server's secret headers stay with the broker: the turn's server list points the engine at
// `http://127.0.0.1:<broker>/b/<token>/mcp-<name>` with no headers, and the broker adds them for the server's real
// address. The token is bound to the conversation and reused for its later turns while the servers are the same, so a
// long-lived engine process keeps its MCP sessions (the driver's launch key stays the same); it slides with each turn
// and ends at its TTL, or when the servers change. A server that failed when the engine started gets the conversation a
// new token on its next turn, so the engine starts again and reconnects instead of keeping that failed connection.
import { createHash } from "node:crypto";

import { listNames } from "../../shared/place-view.ts";
import type { McpServerSpec } from "../contracts.ts";
import { serverLine } from "../server-lines.ts";
import { botBox, type BoxBroker } from "./box.ts";
import { brokerUrl } from "./broker.ts";

export interface BrokerTurn { botId: string; threadId: string }

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const MAX_REMEMBERED = 10_000;
/** The live token per conversation, the servers it was minted for, and their names. */
const remembered = new Map<string, { token: string; fingerprint: string; grant: string; names: string[] }>();
const conversation = (turn: BrokerTurn) => `${turn.botId}\u0000${turn.threadId}`;

/** The grant name for a server: one URL server per name per conversation. */
export function mcpGrantName(name: string): string {
  return `mcp-${name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48)}`;
}

/** Test seam: forget every remembered token. */
export function forgetBrokeredMcp(): void { remembered.clear(); }

/** The turn's custom servers with every URL server's headers moved to the broker; unchanged when the broker is off. */
export function brokerRemoteMcp(custom: Record<string, McpServerSpec>, turn: BrokerTurn, broker: BoxBroker | null = botBox.broker()): Record<string, McpServerSpec> {
  if (!broker) return custom;
  // A turn starting on this conversation keeps its earlier grants alive (a long-lived engine process reuses them).
  broker.touchThread(turn.threadId);
  const out: Record<string, McpServerSpec> = {};
  const grants: Record<string, { upstream: string; headers: Record<string, string> }> = {};
  const brokered: string[] = [];
  for (const [name, server] of Object.entries(custom)) {
    if (!("url" in server) || typeof server.url !== "string" || !NAME.test(name)) { out[name] = server; continue; }
    grants[mcpGrantName(name)] = { upstream: server.url, headers: { ...server.headers } };
    brokered.push(name);
  }
  if (!brokered.length) return custom;
  const key = conversation(turn);
  const fingerprint = createHash("sha256").update(JSON.stringify(Object.entries(grants).sort(([a], [b]) => (a < b ? -1 : 1)))).digest("hex");
  const known = remembered.get(key);
  let token = known && known.fingerprint === fingerprint && broker.lookup(known.token, known.grant).ok ? known.token : null;
  if (!token) {
    token = broker.mintForThread({ botId: turn.botId, threadId: turn.threadId, grants }).token;
    remembered.delete(key);
    remembered.set(key, { token, fingerprint, grant: mcpGrantName(brokered[0]!), names: brokered });
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value!);
  }
  for (const name of brokered) {
    const server = custom[name] as McpServerSpec & { url: string; type?: string };
    out[name] = { ...server, url: brokerUrl(broker.port, token, mcpGrantName(name)), headers: {} } as McpServerSpec;
  }
  return out;
}

/** The engine of this conversation's turn reported servers that failed when it started: when any is a URL server it
 * reaches through the broker, its next turn gets a new token, so the driver starts the engine again and it reconnects.
 * The servers that will, by name. */
export function retryBrokeredMcp(turn: BrokerTurn, failed: readonly string[]): string[] {
  const known = remembered.get(conversation(turn));
  const retried = known ? failed.filter((name) => known.names.includes(name)) : [];
  if (retried.length) remembered.delete(conversation(turn));
  return retried;
}

/** What the chat says when URL servers didn't connect as the engine started, and when they will, in `language`. */
export function mcpReconnectLine(names: readonly string[], language?: string): string {
  return names.length === 1
    ? serverLine(language, "server.mcp.reconnect.one", { name: names[0]! })
    : serverLine(language, "server.mcp.reconnect.many", { names: listNames(names, language) });
}
