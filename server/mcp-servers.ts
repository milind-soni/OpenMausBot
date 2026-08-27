// Per-bot custom MCP servers: the user's own tools, spawned as stdio
// children and handed to whichever engine the bot runs on.
//
// Three rules here are not style, they are the review of the earlier
// attempt (PR #61) written down as code:
//
//   1. `id` is the identity. A name is a label the user edits, so nothing
//      that routes a turn may be derived from it — renaming a server must
//      not silently re-point anything at a different one.
//   2. Two servers may never fold onto the same key. The agent addresses a
//      server by name (`mcp__filesystem`), so a collision means one server
//      quietly wins; that is refused when it is SAVED, where a person can
//      read the error, rather than at turn time where nobody sees it.
//   3. An env value never leaves this process. The wire form keeps the key
//      names and drops the values, and an editor sending a value back
//      untouched sends `true`, which resolves against what is stored.
import { randomUUID } from "node:crypto";

import { z } from "zod";

export interface McpServerSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

/** What the renderer is allowed to see: names of env keys, never values. */
export type WireMcpServer = Omit<McpServerSpec, "env"> & { env: Record<string, true> };

const MAX_SERVERS = 20;
const MAX_NAME = 60;

/** The label folded into the key an agent prefixes its tools with. */
export function mcpKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parsed at the boundary, the way every other PATCH body is: an entry that
 * reaches the loop below is already the right shape, so the checks there are
 * only the ones a schema cannot make — collisions between entries, and env
 * placeholders that have to resolve against what is stored. */
const entrySchema = z.object({
  id: z.string({ error: "id must be a string" }).optional(),
  name: z
    .string({ error: "each MCP server needs a name" })
    .max(MAX_NAME, { error: `a name must be at most ${MAX_NAME} characters` })
    .refine((value) => Boolean(value.trim()), { error: "each MCP server needs a name" }),
  command: z
    .string({ error: "each MCP server needs a command" })
    .refine((value) => Boolean(value.trim()), { error: "each MCP server needs a command" }),
  args: z.array(z.string({ error: "every arg must be a string" }), { error: "args must be an array" }).optional(),
  // a string sets a new value; `true` is the editor saying "keep the stored one"
  env: z
    .record(z.string(), z.union([z.string(), z.literal(true)], { error: "env values must be strings" }), {
      error: "env must be an object",
    })
    .optional(),
  enabled: z.boolean({ error: "enabled must be true or false" }).optional(),
});

const listSchema = z
  .array(entrySchema, { error: "mcpServers must be an array" })
  .max(MAX_SERVERS, { error: `at most ${MAX_SERVERS} MCP servers` });

/** The wire shape, named so the boundary parser takes a domain type rather
 * than `unknown` — same idiom as bot-profile.ts. */
export type McpServersInput = z.input<typeof listSchema>;

export function parseMcpServers(
  value: McpServersInput,
  existing: readonly McpServerSpec[] = [],
  newId: () => string = randomUUID,
): { ok: true; servers: McpServerSpec[] } | { ok: false; error: string } {
  const parsed = listSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "mcpServers is not valid" };
  }

  const servers: McpServerSpec[] = [];
  const keys = new Set<string>();
  for (const entry of parsed.data) {
    const name = entry.name.trim();
    const key = mcpKey(name);
    if (!key) return { ok: false, error: "a name needs at least one letter or digit" };
    if (keys.has(key)) return { ok: false, error: `two MCP servers answer to the same name: ${key}` };
    keys.add(key);

    // An id is only honoured when it names something already stored: an
    // invented one would let a PATCH adopt an identity nothing points at.
    const prior = entry.id ? existing.find((server) => server.id === entry.id) : undefined;

    const env: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(entry.env ?? {})) {
      if (envValue === true) {
        const stored = prior?.env[envKey];
        if (stored === undefined) return { ok: false, error: `no stored value for ${envKey}` };
        env[envKey] = stored;
        continue;
      }
      env[envKey] = envValue;
    }

    servers.push({
      id: prior?.id ?? newId(),
      name,
      command: entry.command.trim(),
      args: entry.args ?? [],
      env,
      enabled: entry.enabled ?? true,
    });
  }
  return { ok: true, servers };
}

export function redactMcpServers(servers: readonly McpServerSpec[]): WireMcpServer[] {
  return servers.map(({ env, ...rest }) => ({
    ...rest,
    env: Object.fromEntries(Object.keys(env).map((key) => [key, true as const])),
  }));
}

export function enabledMcpServers(servers: readonly McpServerSpec[] | undefined): McpServerSpec[] {
  return (servers ?? []).filter((server) => server.enabled);
}
