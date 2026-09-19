// Shared helpers for the ACP driver core (core.ts): the subscription-auth
// bypass for local injected models, model-variant option parsing, image
// block reading, instance config decode, remembered-allow operation keys,
// and the session mcpServers shape. Each one is pure/explicit so core.ts
// stays a handshake and turn runtime.
import { readFile } from "node:fs/promises";

import { decodeInjectId } from "../local-inject.ts";
import type { ModelVariantOption, SendTurnInput, TurnImageInput } from "../../contracts.ts";
import type { AcpConfig } from "./core.ts";
import type {
  AcpConfigOption,
  AcpSessionConfigResult,
  AcpSessionToolCall,
} from "./wire-types.ts";

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

export function acpVariantOption(result: AcpSessionConfigResult | null): { configId: string; options: ModelVariantOption[]; currentValue?: string } | undefined {
  const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
    (entry): entry is AcpConfigOption & { id: string } =>
      entry?.type === "select" && typeof entry.id === "string"
      && (entry.id === "effort" || entry.category === "thought_level"),
  );
  if (!option) return;
  const options: ModelVariantOption[] = [];
  const seen = new Set<string>();
  const collect = (entries: readonly AcpConfigOption[] | undefined) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string" && !seen.has(entry.value)) {
        seen.add(entry.value);
        options.push({ id: entry.value, label: typeof entry.name === "string" ? entry.name : entry.value });
      } else if (Array.isArray(entry?.options)) collect(entry.options);
    }
  };
  collect(option.options);
  return {
    configId: option.id,
    options,
    ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
  };
}

export async function readAcpImageBlocks(images: readonly TurnImageInput[]) {
  return Promise.all(images.map(async (image) => ({
    type: "image" as const,
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mime,
  })));
}

export function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

/** What "the same operation" means for a remembered session allow: the
 * tool call's shape with keys sorted, so two identical requests key alike
 * however the agent ordered its JSON. null when nothing identifies it. */
export function sessionOperationKey(toolCall: AcpSessionToolCall): string | null {
  const rawInput = toolCall?.rawInput;
  const command = typeof rawInput?.command === "string" ? rawInput.command : undefined;
  const hasInput = rawInput && typeof rawInput === "object" && Object.keys(rawInput).length > 0;
  if (!command && !hasInput) return null;
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value;
  return JSON.stringify(stable({
    kind: toolCall?.kind,
    title: toolCall?.title,
    command,
    input: rawInput,
    locations: toolCall?.locations,
  }));
}

// ACP session mcpServers: stdio is the baseline every ACP agent
// supports (mcpCapabilities.http/.sse only add EXTRA transports), so
// an injected stdio proxy — e.g. the peer-agent comms tool — attaches
// fine here. A url server is listed in ACP's http/sse shape and kept
// for the session only when the agent advertised that transport.
// env and headers are the ACP {name,value}[] shape.
type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: "http" | "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> };
export const acpMcpServers = (turn: SendTurnInput) => {
  const servers: AcpMcpServer[] = [];
  const acpEnv = (env: Record<string, string>) =>
    Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
  const agents = turn.integrations?.agents;
  if (agents) {
    servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
  }
  const composio = turn.integrations?.composio;
  if (composio) {
    servers.push({
      name: "composio",
      command: composio.command,
      args: composio.args,
      env: acpEnv(composio.env),
    });
  }
  const browser = turn.integrations?.browser;
  if (browser) {
    servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
  }
  // The bot's computer, mounted exactly like the Claude driver does:
  // host and sandbox Cua connections expose Cua Driver's own MCP server.
  // (A cloud box is not mounted here at all: a cloud turn runs ON the box.)
  if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.push({
      name: "computer",
      command: local.command,
      args: local.args,
      env: acpEnv(local.env ?? {}),
    });
  }
  // user-configured servers, after the built-ins: a residual name
  // collision keeps the built-in (reserved names are filtered at the
  // config boundary; this is defense in depth).
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    if (servers.some((existing) => existing.name === name)) continue;
    if ("url" in server) {
      servers.push({ type: server.type, name, url: server.url, headers: acpEnv(server.headers) });
      continue;
    }
    servers.push({ name, command: server.command, args: server.args, env: acpEnv(server.env) });
  }
  return servers;
};
