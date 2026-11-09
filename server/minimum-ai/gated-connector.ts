import { createWorkflowConnector, type WorkflowConnectorDeps } from "./connector.ts";

export function createGatedWorkflowRelay(options: { endpoint: string; bearer: string; fetcher?: typeof fetch }): WorkflowConnectorDeps["relay"] {
  const url = new URL(options.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/api/internal/connectors/mcp" || url.username || url.password || url.search || url.hash) throw new Error("The connector gate must be a local internal endpoint");
  if (!options.bearer) throw new Error("A connector capability is required");
  const send = options.fetcher ?? fetch;
  return async (payload, session, signal) => {
    const response = await send(url, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${options.bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(payload), signal });
    const limit = 5 * 1024 * 1024;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > limit) throw new Error("Connected tool response exceeds the size limit");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error("Connected tool response exceeds the size limit"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { status: response.status, bytes, transportSessionId: response.headers.get("mcp-session-id") ?? undefined };
  };
}

export function createGatedWorkflowConnector(options: { endpoint: string; bearer: string; authorize: (tool: string) => Promise<boolean>; fetcher?: typeof fetch }) {
  return createWorkflowConnector({ authorize: options.authorize, relay: createGatedWorkflowRelay(options) });
}
