import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRun } from "./ActivityRun";

describe("ActivityRun at narrow widths", () => {
  it("lets the run's row shrink and truncate its summary instead of running off the screen", () => {
    const steps = [
      { id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "b", at: 2, role: "bot" as const, kind: "activity" as const, tool: { name: "mcp__omb__screenshot", ok: true } },
    ];
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toMatch(/<button[^>]*class="flex min-w-0 max-w-full /);
    expect(html).toContain('class="min-w-0 max-w-[480px] truncate font-medium leading-5"');
  });
});
