import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced }));

const { ToolActivity } = await import("./ToolActivity");
const { ActivityRun } = await import("./ActivityRun");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) => renderToStaticMarkup(createElement(ToolActivity, { tool }));

afterEach(() => {
  mode.advanced = false;
});

describe("ToolActivity in Simple mode", () => {
  it("names the step in plain words and keeps the tool's own name in the details", () => {
    const html = render({ name: "mcp__omb__computer_batch", ok: true, input: '{"actions":[]}' });
    expect(html).toContain("Use the computer · Completed · Tool details");
    expect(html).toMatch(/<span class="min-w-0 max-w-\[30rem\] truncate leading-5 font-medium">Use the computer<\/span>/);
    expect(html).toContain('data-testid="tool-name"');
    expect(html).toContain("mcp__omb__computer_batch");
  });

  it("keeps a command off the row, where it reads as a plain step", () => {
    const html = render({ name: "Bash", ok: false, summary: "pnpm test --filter api", input: "pnpm test --filter api" });
    expect(html).toContain("Run a command · Failed · Tool details");
    expect(html).not.toContain('title="pnpm test --filter api"');
  });

  it("names a Composio slug by its action", () => {
    expect(render({ name: "GITHUB_GET_A_COMMIT", ok: true })).toContain("Get a commit · Completed");
  });
});

describe("ToolActivity in Advanced mode", () => {
  it("shows the tool name and command on the row, as before", () => {
    mode.advanced = true;
    const html = render({ name: "Bash", ok: true, summary: "pnpm test", input: "pnpm test" });
    expect(html).toContain("Bash · Completed · Tool details");
    expect(html).toMatch(/truncate leading-5 font-mono">Bash<\/span>/);
    expect(html).toContain('title="pnpm test"');
    expect(html).not.toContain('data-testid="tool-name"');
  });
});

describe("ActivityRun", () => {
  const steps = [
    { id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Bash", ok: true, summary: "ls" } },
    { id: "b", at: 2, role: "bot" as const, kind: "activity" as const, tool: { name: "ls -la /tmp", ok: true, summary: "ls -la /tmp" } },
    { id: "c", at: 3, role: "bot" as const, kind: "activity" as const, tool: { name: "mcp__omb__screenshot", ok: true } },
  ];

  it("sums a folded run up in plain words in Simple mode", () => {
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toContain("3 steps · Run a command ×2, Look at the screen");
  });

  it("keeps the tool names in Advanced mode", () => {
    mode.advanced = true;
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toContain("3 steps · Bash, ls -la /tmp, mcp__omb__screenshot");
  });
});

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
