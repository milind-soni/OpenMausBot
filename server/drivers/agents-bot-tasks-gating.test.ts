import { describe, expect, it } from "vitest";

import { BOT_TASK_TOOL_NAMES } from "./agents-bot-tasks-tools.ts";
import { availableTools } from "./agents-catalog.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { CORE_TOOLS } from "./agents-tool-groups.ts";

const names = (env: NodeJS.ProcessEnv) => new Set(availableTools(catalogProfileFromEnv(env)).map((tool) => tool.name));

describe("the bot task tools", () => {
  it("exist for a bot only while the task list is on", () => {
    const off = names({});
    const on = names({ OMB_BOT_TASKS: "1" });
    expect(on.has("task_post_github")).toBe(false);
    for (const tool of BOT_TASK_TOOL_NAMES) {
      expect(off.has(tool), `${tool} while off`).toBe(false);
      expect(on.has(tool), `${tool} while on`).toBe(true);
    }
  });

  it("add nothing else to the catalog", () => {
    const off = names({});
    const on = names({ OMB_BOT_TASKS: "1" });
    expect([...on].filter((name) => !off.has(name)).sort()).toEqual([...BOT_TASK_TOOL_NAMES].sort());
    expect([...off].filter((name) => !on.has(name))).toEqual([]);
  });

  it("are always-loaded core tools", () => {
    for (const tool of BOT_TASK_TOOL_NAMES) expect(CORE_TOOLS.has(tool), tool).toBe(true);
  });
});
