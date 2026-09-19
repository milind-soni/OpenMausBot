// The contract between the MCP entry (scripts/mcp-server.ts) and its handler
// modules. Every tool is a plain (args, ctx) function returning the raw
// result payload; process-level state (endpoint discovery) and the
// per-request abort wiring arrive through ToolContext explicitly instead of
// module globals. Argument validation keeps the same ToolInputError the
// JSON-RPC layer maps to invalid-params responses.

/** Tool arguments as they arrive from the JSON-RPC client. */
export type Json = Record<string, unknown>;

/** A handler's answer: the raw result payload, stringified by the caller. */
export type ToolHandler = (args: Json, ctx: ToolContext) => Promise<unknown>;

export interface ToolContext {
  /** The request helper with the call's abort signal already bound in. */
  fetch(path: string, options?: RequestInit): Promise<any>;
  /** The call's abort signal, when the client provided one. */
  readonly signal?: AbortSignal;
  /** The endpoint the health check reports: the discovered URL, else the configured one. */
  endpoint(): string;
}

/** Invalid tool input: the JSON-RPC layer reports these as invalid params. */
export class ToolInputError extends Error {}

export function parsePositiveLimit(raw: unknown, fallback = 30, maximum = 200): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new ToolInputError("limit must be a positive number");
  return Math.min(Math.floor(raw), maximum);
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringArg(args: Record<string, unknown>, key: string, options: { trim?: boolean; allowEmpty?: boolean; max?: number } = {}): string {
  const raw = args[key];
  if (typeof raw !== "string") throw new ToolInputError(`${key} must be a string`);
  const value = options.trim === false ? raw : raw.trim();
  if (!options.allowEmpty && !value) throw new ToolInputError(`${key} must not be empty`);
  if (options.max && value.length > options.max) throw new ToolInputError(`${key} must be at most ${options.max} characters`);
  return value;
}

export function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
  options: { trim?: boolean; allowEmpty?: boolean; max?: number } = {},
): string | undefined {
  if (!(key in args)) return undefined;
  return stringArg(args, key, options);
}

export function idArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!/^[\w-]+$/.test(value)) throw new ToolInputError(`${key} is not a valid OpenMausBot ID`);
  return value;
}

export function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ToolInputError(`${key} must be a non-empty list of IDs`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}
