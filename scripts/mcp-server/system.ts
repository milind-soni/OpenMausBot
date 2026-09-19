// System tools: connectivity to the configured or discovered server.

import type { Json, ToolContext, ToolHandler } from "./context.ts";

export const handlers = {
  async get_system_health(_args: Json, ctx: ToolContext): Promise<unknown> {
    const res = await ctx.fetch("/api/health");
    if (res?.app !== "openmausbot") throw new Error("The configured endpoint is not an OpenMausBot server");
    return {
      status: "connected",
      endpoint: ctx.endpoint(),
      app: "openmausbot",
      packaged: Boolean(res.static),
    };
  },
} satisfies Record<string, ToolHandler>;
