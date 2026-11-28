// A relayed MCP server's part of a session's tool budget, for the servers OpenMausBot relays but does not serve:
// connected apps and the person's own servers. The session gives each relay its share in bytes and a file to record
// the list it relays; the relay fits what it lists into the share, and the record sizes the share the next session
// gives it.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { fitToolListToShare, type ListedTool } from "./tool-list-budget.ts";

export const TOOL_LIST_SHARE_ENV = "OMB_TOOL_LIST_SHARE";
export const TOOL_LIST_RECORD_ENV = "OMB_TOOL_LIST_RECORD";

const RECORD_MAX_BYTES = 2 * 1024 * 1024;

function isTool(value: unknown): value is ListedTool {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string";
}

export function toolListShareFromEnv(env: Record<string, string | undefined>): number | undefined {
  const value = env[TOOL_LIST_SHARE_ENV];
  return value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** The tool list last recorded at `path`, or undefined when there is none that can be read. */
export function readRecordedToolList(path: string): ListedTool[] | undefined {
  try {
    if (statSync(path).size > RECORD_MAX_BYTES) return undefined;
    const tools = (JSON.parse(readFileSync(path, "utf8")) as { tools?: unknown }).tools;
    return Array.isArray(tools) && tools.every(isTool) ? tools : undefined;
  } catch {
    return undefined;
  }
}

function record(path: string, tools: readonly ListedTool[]): void {
  try {
    const text = JSON.stringify({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (Buffer.byteLength(text) > RECORD_MAX_BYTES) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const staged = `${path}.${process.pid}.tmp`;
    writeFileSync(staged, text, { mode: 0o600 });
    renameSync(staged, path);
  } catch {
    // A relay that cannot write (a read-only sandbox) still fits its list; the next session sizes it by its reserve.
  }
}

/** A relay's tools as the engine is shown them: recorded when the session asked, then fitted into its share. */
export function toolsForSessionShare(tools: readonly unknown[], env: Record<string, string | undefined>, log?: (line: string) => void): unknown[] {
  const share = toolListShareFromEnv(env);
  const path = env[TOOL_LIST_RECORD_ENV];
  if (share === undefined && !path) return [...tools];
  if (!tools.every(isTool)) return [...tools];
  if (path) record(path, tools);
  if (share === undefined) return [...tools];
  const fitted = fitToolListToShare(tools, share);
  if (!fitted.fits) log?.(`tool list is ${fitted.bytes} bytes at its shortest, ${fitted.bytes - share} over its ${share}-byte share of the session's tool budget`);
  return fitted.tools;
}

/** A tools/list result fitted the same way; anything else, or a page of a longer list, as it came. */
export function toolsListResultForSessionShare(result: unknown, env: Record<string, string | undefined>, log?: (line: string) => void): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (toolListShareFromEnv(env) === undefined && !env[TOOL_LIST_RECORD_ENV]) return result;
  const listing = result as { tools?: unknown; nextCursor?: unknown };
  if (!Array.isArray(listing.tools) || listing.nextCursor !== undefined) return result;
  return { ...listing, tools: toolsForSessionShare(listing.tools, env, log) };
}
