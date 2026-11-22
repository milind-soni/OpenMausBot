import { describe, expect, it } from "vitest";

import { buildDevsReport } from "../devs-report.ts";
import { actionKind, botReason, createBrowserInputLog, pageAction } from "./input-log.ts";

describe("the browser input log", () => {
  it("prints one line a drop with its reason, engine, transport and session, and counts every one", () => {
    const lines: string[] = [];
    let now = Date.UTC(2026, 0, 1);
    const log = createBrowserInputLog((line) => lines.push(line), () => now);
    log.record({ who: "person", reason: "not_controlling", what: "input_mouse", engine: "agent-browser", transport: "v1", session: "omb-a" });
    log.record({ who: "bot", reason: "target_not_found", what: "agent_browser_click", engine: "agent-browser", transport: "tools", session: "omb-a" });
    expect(lines).toEqual([
      "browser input: person input_mouse dropped reason=not_controlling engine=agent-browser transport=v1 session=omb-a",
      "browser input: bot click dropped reason=target_not_found engine=agent-browser transport=tools session=omb-a",
    ]);
    expect(log.lines()).toEqual([
      "person not_controlling input_mouse agent-browser v1: 1; last 2026-01-01T00:00:00.000Z",
      "bot target_not_found click agent-browser tools: 1; last 2026-01-01T00:00:00.000Z",
    ]);
  });

  it("holds a burst of one refusal for one browser to a line, then one more saying how many followed", () => {
    const lines: string[] = [];
    let now = 0;
    const log = createBrowserInputLog((line) => lines.push(line), () => now);
    const drop = (session = "omb-a") => log.record({ who: "person", reason: "not_controlling", what: "input_mouse", engine: "agent-browser", transport: "v1", session });
    for (let i = 0; i < 40; i++) drop();
    drop("omb-b");
    expect(lines).toHaveLength(2);
    now = 5_000;
    drop();
    expect(lines.at(-1)).toBe("browser input: person input_mouse dropped reason=not_controlling engine=agent-browser transport=v1 session=omb-a times=40");
    expect(log.lines()[0]).toMatch(/^person not_controlling input_mouse agent-browser v1: 42; /);
  });

  it("never keeps an action kind, a tool or a session it does not know as given", () => {
    const lines: string[] = [];
    const log = createBrowserInputLog((line) => lines.push(line), () => 0);
    log.record({ who: "person", reason: "other", what: "https://example.com/?q=secret", engine: "chrome", transport: "v2", session: "a session\nwith a line" });
    log.record({ who: "bot", reason: "engine_error", what: "agent_browser_eval", engine: "chrome", transport: "tools", session: "s" });
    expect(lines).toEqual([
      "browser input: person other dropped reason=other engine=chrome transport=v2 session=unknown",
      "browser input: bot other dropped reason=engine_error engine=chrome transport=tools session=s",
    ]);
    expect(actionKind("input_batch")).toBe("input_batch");
    expect(pageAction("agent_browser_fill")).toBe("fill");
    expect(pageAction("agent_browser_snapshot")).toBeNull();
  });

  it("names a bot's failure by a fixed code, whatever the engine wrote", () => {
    expect(botReason("Element not found: #pay-now. Verify the selector, role, or name is correct and the element exists in the DOM.")).toBe("target_not_found");
    expect(botReason("Unknown ref: e99")).toBe("target_not_found");
    expect(botReason("No element matches #inner.")).toBe("target_not_found");
    expect(botReason("Could not locate element with role=button name=Go")).toBe("target_not_found");
    expect(botReason("Element '#covered' is covered by <div#cover> at its click point, so the input would land on that element instead.")).toBe("target_not_actionable");
    expect(botReason("Browser tools are paused while a person controls this browser.")).toBe("person_holds_control");
    expect(botReason("The browser engine is stuck. Press Restart.")).toBe("browser_stuck");
    expect(botReason("Something nobody expected")).toBe("engine_error");
  });

  it("reaches the bug report's diagnostics, and only when there is something to say", () => {
    const input = {
      installId: "install", appVersion: "0.0.0", platform: "linux", os: "linux", runsOn: "My Cloud", node: "v0", uptimeSeconds: 60, now: 0,
      threadId: "thread", messageId: "message", where: "a chat", message: "@devs the browser takes no clicks", bots: [], problems: [], log: [], noSummary: "none",
    } as unknown as Parameters<typeof buildDevsReport>[0];
    expect(buildDevsReport(input, []).diagnostics).not.toContain("Browser input");
    const log = createBrowserInputLog(() => {}, () => Date.UTC(2026, 10, 21));
    log.record({ who: "app", reason: "queue_halted", what: "input", engine: "agent-browser", transport: "v1", session: "omb-a", count: 7 });
    expect(buildDevsReport({ ...input, browserInput: log.lines() }, []).diagnostics)
      .toContain("## Browser input that did not reach the page since the server started\napp queue_halted input agent-browser v1: 7; last 2026-11-21T00:00:00.000Z");
  });
});
