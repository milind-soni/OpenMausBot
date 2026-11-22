import { describe, expect, it } from "vitest";

import { HOLD_READ_TOOLS, readsDuringHold } from "./dispatch.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "./prompt.ts";
import { TOOL_LIST } from "./tools.ts";

describe("what the bot is told about a person's hold", () => {
  it("names exactly the tools that still work, in the forms that do", () => {
    const hold = CHROME_BROWSER_SYSTEM_PROMPT.slice(CHROME_BROWSER_SYSTEM_PROMPT.indexOf("While a person controls your browser"));
    const named = new Set(TOOL_LIST.map((tool) => tool.name).filter((name) => hold.includes(name)));
    expect([...named].sort()).toEqual([...HOLD_READ_TOOLS].sort());
    expect(readsDuringHold({ name: "agent_browser_screenshot", input: { fullPage: true } } as never)).toBe(false);
    expect(readsDuringHold({ name: "agent_browser_read", input: { url: "https://example.com" } } as never)).toBe(false);
    expect(readsDuringHold({ name: "agent_browser_tabs", input: { action: "switch" } } as never)).toBe(false);
  });
});
