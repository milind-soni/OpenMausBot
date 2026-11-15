// The tool groups a person turned off for a bot, as the bot's prompt and the app's Settings see them.
import { TOOL_GROUP_LABELS, TOOL_GROUPS, type ToolGroup } from "../shared/tool-groups.ts";

/** The prompt part that tells a bot which of its tools the person turned off, so it can say so instead of guessing. */
export function toolsOffPart(bot: { toolsOff?: readonly string[] } | null | undefined): { id: string; label: string; text: string } {
  const off = TOOL_GROUPS.filter((group) => bot?.toolsOff?.includes(group));
  const text = off.length === 0 ? "" : ` The person turned off some of your tools to keep requests small: ${off.map((group) => TOOL_GROUP_LABELS[group]).join(", ")}. When they ask for something those tools do, tell them in one line that it is turned off for you and that they can turn it back on in your Settings (Access, Tools), or ask you to.`;
  return { id: "tools-off", label: "Tools turned off", text };
}

/** The groups this workspace has, the ones its bots' Settings offer to turn off. */
export function availableToolGroups(has: { meetings: boolean; data: boolean; images: boolean; email: boolean }): ToolGroup[] {
  return TOOL_GROUPS.filter((group) => group === "pages" || has[group]);
}
