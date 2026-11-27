// JSON-RPC between an MCP app frame and its host (io.modelcontextprotocol/ui, stable 2026-01-26).
export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

/** The only methods an app frame may ask its server for; the server refuses any other with 400. */
export const APP_RPC_METHODS = ["tools/call", "tools/list", "resources/read", "resources/list"] as const;
export type AppRpcMethod = (typeof APP_RPC_METHODS)[number];

/** What a bot's page may ask its own server for, each only when the page declared it (show_html `uses`):
 * `mausbot/data/query` {sql, params?} → {columns, rows, truncated}; `mausbot/state/get` {key} → {value?};
 * `mausbot/state/set` {key, value?} (no value removes the key) → {}; `mausbot/state/keys` {} → {keys};
 * `mausbot/connectors/call` {connector | server, tool, arguments?, engaged} → {result, truncated?} where `engaged` is the
 * host's own word on whether the person clicked in the page just now, never the page's;
 * `mausbot/connectors/list` {} → {connectors: [{connector | server, label, connected, tools}]}. */
export const PAGE_RPC_METHODS = [
  "mausbot/data/query", "mausbot/state/get", "mausbot/state/set", "mausbot/state/keys", "mausbot/connectors/call", "mausbot/connectors/list",
] as const;
export type PageRpcMethod = (typeof PAGE_RPC_METHODS)[number];
/** What a page method needs the page to have declared. */
export type PageUse = "data" | "state" | "connectors";

export function pageMethodUse(method: PageRpcMethod): PageUse {
  return method === "mausbot/data/query" ? "data" : method.startsWith("mausbot/connectors/") ? "connectors" : "state";
}

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_HOST_REFUSED = -32000;
