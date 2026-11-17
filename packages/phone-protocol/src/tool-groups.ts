/** Groups of built-in tools a person can turn off for one bot (`Bot.toolsOff`), so its model is not sent their
 * definitions on every request. A trim, not a permission: a bot with a group on is held to the same rules as before. */
export const TOOL_GROUPS = ["meetings", "data", "pages", "images", "email"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** How a group is named where the server writes to the bot or the person in English. */
export const TOOL_GROUP_LABELS: Readonly<Record<ToolGroup, string>> = {
  meetings: "Meetings", data: "Data", pages: "Pages and apps", images: "Images", email: "Email",
};

/** About how many tokens each group's tool definitions add to every request where the workspace has the group. */
export const TOOL_GROUP_TOKENS: Readonly<Record<ToolGroup, number>> = {
  meetings: 900, data: 1600, pages: 1500, images: 200, email: 1300,
};

/** The agents server's environment variable that carries `toolsOff`: group ids joined with commas. */
export const TOOLS_OFF_ENV = "OMB_TOOLS_OFF";

export function isToolGroup(value: unknown): value is ToolGroup {
  return typeof value === "string" && (TOOL_GROUPS as readonly string[]).includes(value);
}

/** A saved or sent `toolsOff`: known groups only, each once, in TOOL_GROUPS order; null when it is not a list of them. */
export function parseToolsOff(value: unknown): ToolGroup[] | null {
  if (!Array.isArray(value) || !value.every(isToolGroup)) return null;
  return TOOL_GROUPS.filter((group) => value.includes(group));
}

/** The groups OMB_TOOLS_OFF names; an unknown name is ignored, so an older proxy never fails a turn. */
export function toolsOffFromEnv(value: string | undefined): ToolGroup[] {
  const named = (value ?? "").split(",");
  return TOOL_GROUPS.filter((group) => named.includes(group));
}
