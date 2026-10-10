import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunLog } from "./RunLog";
import { timelineEvents, type TimelineEvent } from "@/lib/taskTimeline";

const render = (events: TimelineEvent[]) => renderToStaticMarkup(createElement(RunLog, { events }));

describe("Run log", () => {
  it("shows an honest empty state without a copy control", () => {
    const html = render([]);
    expect(html).toContain("No recorded activity");
    expect(html).not.toContain("Copy redacted run log");
  });

  it("renders commands, failure and pending states without fabricating output", () => {
    const html = render(timelineEvents([
      { id: "a", at: 1, role: "bot", kind: "activity", tool: { name: "Bash", summary: "pnpm control:omb doctor", ok: true } },
      { id: "b", at: 2, role: "bot", kind: "activity", tool: { name: "Bash", summary: "pnpm control:omb ui click --name Missing", ok: false } },
      { id: "c", at: 3, role: "bot", kind: "activity", tool: { name: "Read" } },
    ]));
    expect(html).toContain("pnpm control:omb doctor");
    expect(html).toContain("Completed");
    expect(html).toContain("Failed");
    expect(html).toContain("In progress");
    expect(html).toContain("Commands may be shortened");
    expect(html).toContain('aria-label="Copy redacted run log"');
    expect(html).not.toContain("tests passed");
  });

  it("keeps long histories bounded and wraps command text", () => {
    const events: TimelineEvent[] = Array.from({ length: 205 }, (_, i) => ({ id: `${i}`, at: i, label: `item-${i}`, state: "complete", kind: "tool", command: `echo item-${i}` }));
    const html = render(events);
    expect(html).toContain("latest 200 entries");
    expect(html).not.toContain("echo item-0<");
    expect(html).toContain("echo item-204");
    expect(html).toContain("whitespace-pre-wrap break-all");
    expect(html.match(/<li /g)).toHaveLength(200);
  });
});
