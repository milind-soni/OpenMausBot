export type McpFailureKind = "not_running" | "unauthorized" | "timeout" | "protocol";

export class McpError extends Error {
  readonly kind: McpFailureKind;
  constructor(kind: McpFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface McpTarget {
  endpoint: string;
  token?: string;
  timeoutMs: number;
  transport?: "local-mcp-http" | "local-mcp-sse";
  protocolVersion?: string;
}

export type Json = Record<string, unknown>;

export function checkStatus(res: Response) {
  if (res.status === 401 || res.status === 403) {
    throw new McpError("unauthorized", "The app refused the connection. Check its access settings.");
  }
  if (!res.ok) throw new McpError("protocol", `The app answered with an error (HTTP ${res.status}).`);
}

export function rpcResult(msg: Json): Json {
  if (msg.error) {
    const err = msg.error as { message?: string };
    throw new McpError("protocol", typeof err.message === "string" ? `The app reported: ${err.message}` : "The app reported an error.");
  }
  if (!msg.result || typeof msg.result !== "object") throw new McpError("protocol", "The app sent an invalid reply.");
  return msg.result as Json;
}
