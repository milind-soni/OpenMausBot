// Every agents tool sits in exactly one switchable group or in the core, and turning a group off takes out that group's
// tools and nothing else, byte for byte.
import { describe, expect, it } from "vitest";

import { TOOL_GROUP_TOKENS, TOOL_GROUPS, type ToolGroup } from "../../shared/tool-groups.ts";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { DATA_TOOLS } from "../data/tools.ts";
import { EMAIL_TOOLS } from "../email/tools.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { CORE_TOOLS, OWN_SWITCH_TOOLS, serverTurnedOff, TOOL_GROUP_MEMBERS, toolsOffNames } from "./agents-tool-groups.ts";

/** Every host switch on: a Chief's MausBot on a server with a cloud computer, images, hosting and research. */
const FULLEST = {
  OMB_BOT_ID: "bot-full", OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1", OMB_VOICE_NOTES: "1", OMB_CHIEF_OF_STAFF: "1",
  OMB_COMPUTER_SELECTION: "1", OMB_X_RESEARCH: "1", OMB_RESEARCH: "1", OMB_TEAM_PEOPLE: "1", OMB_IMAGE_GENERATION: "1", OMB_APP_HOSTING: "1",
  OMB_MEETINGS: "1", OMB_MAUSBOT: "1",
};
const listed = (env: Record<string, string>) => availableTools(catalogProfileFromEnv(env));
const names = (env: Record<string, string>) => listed(env).map((tool) => tool.name);
/** The catalog's every tool, across the profiles that between them mount all of it. */
const EVERY_TOOL = new Set([
  ...names(FULLEST),
  ...names({ ...FULLEST, OMB_TEAM_PEOPLE: "0", OMB_CLOUD_HOME: "1" }),
  ...names({ ...FULLEST, OMB_BOT_ID: WATCHER_OPTIONS_CARD_BOT_ID }),
]);
const buckets: Array<[string, ReadonlySet<string>]> = [
  ...TOOL_GROUPS.map((group): [string, ReadonlySet<string>] => [group, TOOL_GROUP_MEMBERS[group].tools]),
  ...Object.entries(OWN_SWITCH_TOOLS),
  ["core", CORE_TOOLS],
];

describe("tool groups on the agents server", () => {
  it("puts every catalog tool in exactly one group or the core, and names no tool the catalog lacks", () => {
    for (const tool of EVERY_TOOL) {
      expect(buckets.filter(([, members]) => members.has(tool)).map(([bucket]) => bucket), tool).toHaveLength(1);
    }
    for (const [bucket, members] of buckets) for (const tool of members) expect(EVERY_TOOL.has(tool), `${bucket}: ${tool}`).toBe(true);
  });

  it("leaves out each group's tools and nothing else, the rest byte for byte", () => {
    const full = listed(FULLEST);
    for (const group of TOOL_GROUPS) {
      const without = listed({ ...FULLEST, OMB_TOOLS_OFF: group });
      expect(JSON.stringify(without), group).toBe(JSON.stringify(full.filter((tool) => !TOOL_GROUP_MEMBERS[group].tools.has(tool.name))));
      if (TOOL_GROUP_MEMBERS[group].tools.size) expect(without.length, group).toBeLessThan(full.length);
    }
  });

  it("with every group off keeps the core and the tools with switches of their own", () => {
    const left = names({ ...FULLEST, OMB_TOOLS_OFF: TOOL_GROUPS.join(",") });
    expect(left).toEqual(names(FULLEST).filter((tool) => !toolsOffNames(TOOL_GROUPS).has(tool)));
    for (const tool of ["show_html", "publish_page", "unpublish_page", "publish_app", "check_app_hosting", "join_meeting", "post_meeting_notes", "generate_image"]) {
      expect(left).not.toContain(tool);
    }
    expect(left).toEqual(expect.arrayContaining(["show_widget", "memory_update", "x_search", "message_person", "app_settings"]));
  });

  it("is the same list for a variable naming no group, an unknown one or none", () => {
    const full = JSON.stringify(listed(FULLEST));
    for (const value of ["", "browser", ",,"]) expect(JSON.stringify(listed({ ...FULLEST, OMB_TOOLS_OFF: value })), value).toBe(full);
  });

  it("stands Data and Email for their own servers", () => {
    expect(serverTurnedOff(["data"], "data")).toBe(true);
    expect(serverTurnedOff(["data"], "email")).toBe(false);
    expect(serverTurnedOff(["email", "pages"], "email")).toBe(true);
    expect(serverTurnedOff(["browser"], "data")).toBe(false);
    expect(serverTurnedOff(undefined, "data")).toBe(false);
  });

  it("says roughly what each group costs a request, a token being about four bytes of definitions", () => {
    const full = listed(FULLEST);
    const bytes: Record<ToolGroup, number> = {
      meetings: 0, pages: 0, images: 0,
      data: JSON.stringify(DATA_TOOLS).length,
      email: JSON.stringify(EMAIL_TOOLS).length,
    };
    for (const group of ["meetings", "pages", "images"] as const) {
      bytes[group] = full.filter((tool) => TOOL_GROUP_MEMBERS[group].tools.has(tool.name)).reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
    }
    for (const group of TOOL_GROUPS) {
      const tokens = bytes[group] / 4;
      expect(TOOL_GROUP_TOKENS[group], `${group}: about ${Math.round(tokens)}`).toBeGreaterThan(tokens * 0.8);
      expect(TOOL_GROUP_TOKENS[group], `${group}: about ${Math.round(tokens)}`).toBeLessThan(tokens * 1.25);
    }
  });
});
