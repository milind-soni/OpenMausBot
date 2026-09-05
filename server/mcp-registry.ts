import { z } from "zod";

export interface StoredMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface McpServerListing {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}

export const MAX_MCP_SERVERS = 20;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names used to route OpenMausBot's built-in MCP proxies and their ephemeral
 * capabilities. Codex exposes MCP env names through one app-server process;
 * a custom server must never request one of these names or it could redirect
 * a built-in proxy or receive that proxy's bearer. */
export function isHarnessOwnedMcpEnvName(name: string): boolean {
  return name === "ELECTRON_RUN_AS_NODE" || name.startsWith("OMB_") || name.startsWith("OGB_");
}

function environmentNameError(name: string): string | null {
  if (!ENV_NAME.test(name)) return `Environment variable “${name}” is not valid.`;
  if (isHarnessOwnedMcpEnvName(name)) {
    return `Environment variable “${name}” is reserved by OpenMausBot.`;
  }
  return null;
}

const RESERVED_MCP_NAMES = new Set([
  "ogb",
  "computer",
  "agents",
  "composio",
  "browser",
  "phone",
  "dweb",
  "openmausbot_connectors",
  "openmausbot_phone",
]);

const storedEntrySchema = z.object({
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(4_096)).max(MAX_ARGS).optional(),
  env: z.record(z.string(), z.string().max(16_384)).optional(),
  enabled: z.boolean().optional(),
}).strict();

const mutationEntrySchema = storedEntrySchema.extend({
  env: z.record(z.string(), z.union([z.string().max(16_384), z.literal(true)])).optional(),
});

export function mcpServerNameError(name: string): string | null {
  if (!MCP_NAME.test(name)) {
    return "Use 1–32 lowercase letters, numbers, underscores, or hyphens, starting with a letter.";
  }
  if (RESERVED_MCP_NAMES.has(name)) return "That name is reserved by OpenMausBot.";
  return null;
}

export function parseStoredMcpServer(
  name: string,
  raw: unknown,
): { ok: true; server: StoredMcpServer } | { ok: false; error: string } {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  const parsed = storedEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const env = parsed.data.env ?? {};
  const invalidEnv = Object.keys(env).map(environmentNameError).find((error) => error !== null);
  if (invalidEnv) return { ok: false, error: invalidEnv };
  if (Object.keys(env).length > MAX_ENV) {
    return { ok: false, error: `Use at most ${MAX_ENV} environment variables.` };
  }
  return {
    ok: true,
    server: {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env,
      enabled: parsed.data.enabled !== false,
    },
  };
}

/** Parse a renderer mutation. `true` is a write-only placeholder meaning
 * “keep this already stored value”; it is never accepted for a new key. */
export function parseMcpServerMutation(
  name: string,
  raw: unknown,
  existing?: StoredMcpServer,
): { ok: true; server: StoredMcpServer } | { ok: false; error: string } {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  const parsed = mutationEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const incomingEnv = parsed.data.env ?? {};
  const invalidEnv = Object.keys(incomingEnv).map(environmentNameError).find((error) => error !== null);
  if (invalidEnv) return { ok: false, error: invalidEnv };
  if (Object.keys(incomingEnv).length > MAX_ENV) {
    return { ok: false, error: `Use at most ${MAX_ENV} environment variables.` };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(incomingEnv)) {
    if (value === true) {
      const saved = existing?.env[key];
      if (saved === undefined) return { ok: false, error: `No saved value exists for ${key}.` };
      env[key] = saved;
    } else {
      env[key] = value;
    }
  }
  return {
    ok: true,
    server: {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env,
      // A newly added command is inert until the person has tested and
      // explicitly enabled it. Existing file-authored entries keep today's
      // enabled-by-default behavior through parseStoredMcpServer.
      enabled: existing ? (parsed.data.enabled ?? existing.enabled) : false,
    },
  };
}

export function listMcpServers(raw: Record<string, unknown> | undefined): McpServerListing[] {
  return Object.entries(raw ?? {}).flatMap(([name, value]) => {
    const parsed = parseStoredMcpServer(name, value);
    if (!parsed.ok) return [];
    return [{
      name,
      command: parsed.server.command,
      args: parsed.server.args,
      envKeys: Object.keys(parsed.server.env).sort(),
      enabled: parsed.server.enabled,
    }];
  });
}
