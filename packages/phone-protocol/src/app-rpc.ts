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

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_HOST_REFUSED = -32000;
