// What OMB's MCP plumbing sees of an MCP App. Only the innermost OMB component on a server's path (the gate,
// the remote proxy or the Chat Completions client) observes it, so a call is reported once. A report never
// delays or alters what is relayed to the engine. This module runs inside spawned proxies: it imports
// nothing heavy.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { APP_EXTENSION_KEY, APP_MIME } from "../shared/app.ts";

export const APP_ONLY_REFUSAL = "This tool belongs to an app view.";
export const APP_REPORT_MAX_BYTES = 900 * 1024;
export const APP_REPORT_TIMEOUT_MS = 10_000;
export const GATE_APPS_ENV = "OMB_GATE_APPS";
export const REMOTE_MCP_APPS_ENV = "OMB_REMOTE_MCP_APPS";

export const UI_EXTENSION = { mimeTypes: [APP_MIME] } as const;

export interface AppMount {
  server: string;
  harnessUrl: string;
  token: string;
  extension: boolean;
}

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Present but unreadable throws: a mount told to observe never silently stops observing. */
export function parseAppMount(raw: string | undefined): AppMount | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid MCP apps configuration"); }
  if (!isRecord(value) || typeof value.server !== "string" || !SERVER_NAME.test(value.server)
    || typeof value.harnessUrl !== "string" || typeof value.token !== "string" || !value.token || typeof value.extension !== "boolean") {
    throw new Error("invalid MCP apps configuration");
  }
  try {
    const url = new URL(value.harnessUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch { throw new Error("invalid MCP apps configuration"); }
  return { server: value.server, harnessUrl: value.harnessUrl, token: value.token, extension: value.extension };
}

export function uiMeta(item: unknown): Json | undefined {
  const meta = isRecord(item) ? item._meta : undefined;
  return isRecord(meta) && isRecord(meta.ui) ? meta.ui : undefined;
}

/** `_meta.ui.resourceUri`, else the deprecated flat `_meta["ui/resourceUri"]`; only a `ui://` URI is a UI. */
export function toolUiResource(tool: unknown): string | undefined {
  const meta = isRecord(tool) && isRecord(tool._meta) ? tool._meta : undefined;
  const ui = uiMeta(tool);
  const uri = typeof ui?.resourceUri === "string" ? ui.resourceUri : typeof meta?.["ui/resourceUri"] === "string" ? meta["ui/resourceUri"] : undefined;
  return uri && uri.startsWith("ui://") && uri.length <= 2_048 ? uri : undefined;
}

export type AppVisibility = "model" | "app";

/** `_meta.ui.visibility` defaults to model and app. */
export function toolVisibility(tool: unknown): AppVisibility[] {
  const list = uiMeta(tool)?.visibility;
  if (!Array.isArray(list)) return ["model", "app"];
  return (["model", "app"] as const).filter((who) => list.includes(who));
}

export function modelVisible(tool: unknown): boolean {
  return toolVisibility(tool).includes("model");
}

export function withoutAppOnlyTools<T>(result: T): T {
  if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.every(modelVisible)) return result;
  return { ...result, tools: result.tools.filter(modelVisible) } as T;
}

export function withUiExtension(params: unknown): Json {
  const base = isRecord(params) ? params : {};
  const capabilities = isRecord(base.capabilities) ? base.capabilities : {};
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : {};
  return { ...base, capabilities: { ...capabilities, extensions: { ...extensions, [APP_EXTENSION_KEY]: UI_EXTENSION } } };
}

export interface AppToolDefinitionReport {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: object;
  annotations?: object;
  _meta: object;
}

export interface McpAppReport {
  tool: "mcp_app";
  server: string;
  serverInfo?: { name?: string; title?: string; version?: string };
  definition: AppToolDefinitionReport;
  call: { arguments: Record<string, unknown>; toolUseId?: string };
  result: { content: unknown[]; structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean };
  /** set when structuredContent was dropped to fit */
  oversized?: true;
}

function definitionOf(tool: Json): AppToolDefinitionReport {
  return {
    name: String(tool.name),
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
    _meta: isRecord(tool._meta) ? tool._meta : {},
  };
}

function serverInfoOf(result: unknown): McpAppReport["serverInfo"] | undefined {
  const info = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo : undefined;
  if (!info) return undefined;
  const out: NonNullable<McpAppReport["serverInfo"]> = {};
  for (const key of ["name", "title", "version"] as const) if (typeof info[key] === "string") out[key] = (info[key] as string).slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}

const bytes = (text: string) => Buffer.byteLength(text);

export function appReportBody(report: McpAppReport, maxBytes = APP_REPORT_MAX_BYTES): string | null {
  let body = JSON.stringify(report);
  if (bytes(body) <= maxBytes) return body;
  const { structuredContent: _dropped, ...result } = report.result;
  let smaller: McpAppReport = { ...report, result, oversized: true };
  body = JSON.stringify(smaller);
  if (bytes(body) <= maxBytes) return body;
  const texts = result.content.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string") as Array<{ type: "text"; text: string }>;
  smaller = { ...smaller, result: { ...result, content: texts } };
  body = JSON.stringify(smaller);
  if (bytes(body) <= maxBytes) return body;
  const over = bytes(body) - maxBytes;
  const total = texts.reduce((sum, block) => sum + bytes(block.text), 0);
  if (total <= over) return null;
  // JSON escaping can make a character cost more than its UTF-8 bytes, so shrink until it fits.
  for (let keep = (total - over) / total; keep > 0.01; keep *= 0.8) {
    const clipped = texts.map((block) => ({ type: "text" as const, text: `${block.text.slice(0, Math.floor(block.text.length * keep))}…` }));
    body = JSON.stringify({ ...smaller, result: { ...result, content: clipped } });
    if (bytes(body) <= maxBytes) return body;
  }
  return null;
}

export function postAppReport(mount: Pick<AppMount, "harnessUrl" | "token">, body: string, log: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL("/api/internal/options-card", mount.harnessUrl); } catch { resolve(); return; }
    // node:http rather than fetch: the harness is on loopback, and an
    // engine's environment may switch on Node's env proxy for fetch.
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, {
      method: "POST",
      headers: { authorization: `Bearer ${mount.token}`, "content-type": "application/json", "content-length": String(bytes(body)) },
      timeout: APP_REPORT_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      if (status < 200 || status >= 300) log(`app report answered HTTP ${status}`);
      response.on("end", resolve);
      response.on("error", () => resolve());
    });
    request.on("timeout", () => { request.destroy(new Error("timed out")); });
    request.on("error", (error) => { log(`app report failed: ${error.message}`); resolve(); });
    request.end(body);
  });
}

export interface AppObserverOptions {
  post?: (body: string) => Promise<void>;
  /** stderr: stdout is the MCP transport. */
  log?: (line: string) => void;
}

export class AppObserver {
  readonly mount: AppMount;
  private readonly tools = new Map<string, Json>();
  private info: McpAppReport["serverInfo"] | undefined;
  private readonly post: (body: string) => Promise<void>;
  private readonly log: (line: string) => void;
  readonly inFlight = new Set<Promise<void>>();

  constructor(mount: AppMount, options: AppObserverOptions = {}) {
    this.mount = mount;
    this.log = options.log ?? ((line) => process.stderr.write(`mcp apps(${mount.server}): ${line}\n`));
    this.post = options.post ?? ((body) => postAppReport(mount, body, this.log));
  }

  initialized(result: unknown): void {
    this.info = serverInfoOf(result) ?? this.info;
  }

  listed(result: unknown): void {
    if (!isRecord(result) || !Array.isArray(result.tools)) return;
    for (const tool of result.tools) {
      if (isRecord(tool) && typeof tool.name === "string" && tool.name) this.tools.set(tool.name, tool);
    }
  }

  appOnly(name: unknown): boolean {
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    return tool !== undefined && !modelVisible(tool);
  }

  /** Built now, from the result as the server sent it, before anything trims it. */
  returned(params: unknown, result: unknown): void {
    try {
      if (!isRecord(params) || typeof params.name !== "string" || !isRecord(result) || !Array.isArray(result.content)) return;
      const tool = this.tools.get(params.name);
      if (!tool || !toolUiResource(tool)) return;
      const meta = isRecord(params._meta) ? params._meta : undefined;
      const toolUseId = typeof meta?.["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string).slice(0, 200) : undefined;
      const report: McpAppReport = {
        tool: "mcp_app",
        server: this.mount.server,
        ...(this.info ? { serverInfo: this.info } : {}),
        definition: definitionOf(tool),
        call: { arguments: isRecord(params.arguments) ? params.arguments : {}, ...(toolUseId ? { toolUseId } : {}) },
        result: {
          content: result.content,
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
          ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
          ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
        },
      };
      const body = appReportBody(report);
      if (body === null) { this.log(`${params.name}: the call is too large to show as an app`); return; }
      const sent = this.post(body).catch((error: unknown) => this.log(`app report failed: ${String(error)}`));
      this.inFlight.add(sent);
      void sent.finally(() => this.inFlight.delete(sent));
    } catch (error) {
      // An observer never breaks the relay.
      this.log(`could not report a call: ${String(error)}`);
    }
  }
}
