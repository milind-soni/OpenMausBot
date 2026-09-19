// MCP integration and relay: the provider-facing proxy command and the
// request bridge to the Session or managed-broker MCP endpoint.
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { AppConfig } from "../config.ts";
import {
  backendFingerprint,
  brokerAccess,
  configured,
  projectApiKey,
  rememberTransportSession,
  transportSessionBackends,
  type ComposioMcpIntegration,
} from "./state.ts";
import { ensureProjectSession } from "./sessions.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface IntegrationContext {
  harnessUrl: string;
  commsToken: string;
  botId: string;
  threadId: string;
}

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  if (!configured(cfg)) return null;
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The provider-facing bridge receives only this boot's loopback token.
      // Project/broker credentials stay in the harness process, so a coding
      // agent that prints its environment cannot export a durable secret.
      OMB_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.commsToken}` }),
      OMB_HARNESS_URL: context.harnessUrl,
      // Distinct from the agents proxy token: Codex flattens mounted MCP env
      // variables into one process environment, so a shared name would let
      // the later agents mount overwrite this connector-scoped capability.
      OMB_CONNECTOR_TOKEN: context.commsToken,
      OMB_BOT_ID: context.botId,
      OMB_THREAD_ID: context.threadId,
    },
  };
}

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const apiKey = projectApiKey(cfg);
  let url: string;
  let identity: string;
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (apiKey) {
    const session = await ensureProjectSession(cfg);
    url = session.mcp.url;
    headers.set("x-api-key", apiKey);
    identity = backendFingerprint("project-mcp", url, apiKey);
  } else {
    const broker = brokerAccess();
    if (!broker) throw new Error("Connected apps are unavailable");
    url = `${broker.url}/v1/mcp`;
    headers.set("authorization", `Bearer ${broker.token}`);
    identity = backendFingerprint("managed-mcp", url, broker.token);
  }
  const knownIdentity = transportSessionId
    ? transportSessionBackends.get(transportSessionId)
    : undefined;
  const forwardedTransportSessionId = transportSessionId
    && knownIdentity === identity
    ? transportSessionId
    : undefined;
  if (forwardedTransportSessionId) {
    headers.set("mcp-session-id", forwardedTransportSessionId);
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  if (forwardedTransportSessionId) rememberTransportSession(forwardedTransportSessionId, identity);
  const nextTransportSessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (nextTransportSessionId) rememberTransportSession(nextTransportSessionId, identity);
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    transportSessionId: nextTransportSessionId,
  };
}
