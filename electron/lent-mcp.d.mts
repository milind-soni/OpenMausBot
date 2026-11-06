export type LentMcpServer =
  | { name: string; command: string; args: string[]; env: Record<string, string> }
  | { name: string; url: string; type: "http" | "sse"; headers: Record<string, string> };
export const LENT_MCP_ACTIONS: ReadonlySet<"mcp_tools" | "mcp_call">;
export function validLentMcpServer(server: unknown): server is LentMcpServer;
export function isLoopbackAddress(url: string): boolean;
export function lentMcpRefusal(grant: { cloud?: unknown; terminal?: boolean }, server: LentMcpServer): string | null;
export function ownEnvironmentIds(dataDirs: ReadonlyArray<string | null | undefined>): string[];
export function inheritedEnvironment(env?: NodeJS.ProcessEnv): Record<string, string>;
export function windowsLaunch(command: string, args: string[], env: Record<string, string | undefined>, exists?: (file: string) => boolean): { file: string; args: string[]; verbatim: boolean } | null;
export function createLentMcp(options?: {
  environment?: () => Record<string, string> | Promise<Record<string, string>>;
  home?: string;
  fetch?: typeof fetch;
}): {
  call(operation: { action: "mcp_tools" | "mcp_call"; server: LentMcpServer; tool_name?: string; arguments?: Record<string, unknown> }, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};
