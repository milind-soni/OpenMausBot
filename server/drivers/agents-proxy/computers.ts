// Computer-surface tools: the opt-in shared desktops and the selector that
// decides where this conversation's computer work happens.
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

// Second lock. With sharing off the tool is not in AVAILABLE_TOOLS, so a
// call is already refused there as an unknown tool — the same answer a
// build without the feature gives. This keeps the handlers themselves
// refusing if that list is ever assembled differently.
function sharingOff(): ToolOutcome {
  return { text: "Computer sharing is turned off in this workspace. There are no shared computers to use.", isError: true };
}

export const handlers = {
  async list_shared_computers(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    if (!ctx.computerSharingEnabled) return sharingOff();
    return { text: JSON.stringify(await ctx.api("/api/internal/shared-computers")) };
  },
  async shared_computer(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    if (!ctx.computerSharingEnabled) return sharingOff();
    const response = await ctx.api("/api/internal/shared-computers", { method: "POST", body: JSON.stringify(args) });
    const result = ctx.jsonRecord(response.result) ? response.result : undefined;
    if (result && Array.isArray(result.content)) return { result };
    return { text: JSON.stringify(result ?? response) };
  },
  async select_computer(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    if (args.surface !== undefined && (typeof args.surface !== "string" || !["auto", "cloud", "vm", "local", "browser"].includes(args.surface))) {
      return { text: "Choose auto, cloud, vm, local or browser; omit surface to inspect connected choices.", isError: true };
    }
    const result = await ctx.api("/api/internal/computer/select", args.surface === undefined ? undefined : {
      method: "POST", body: JSON.stringify({ surface: args.surface }),
    });
    return { text: JSON.stringify(result) };
  },
} satisfies Record<string, ToolHandler>;
