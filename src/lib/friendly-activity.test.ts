import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { friendlyNowPhrases, toolService } from "./friendly-activity";

const running = (name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id: "m", role: "bot", kind: "activity", at: 1, tool: { name, ...extra } });

describe("Simple mode's working line", () => {
  it("says something friendly while nothing is reported, rotating through a few", () => {
    expect(friendlyNowPhrases(null).phrases).toEqual(["Thinking it through", "Mulling it over", "Working on it", "Chipping away"]);
    expect(friendlyNowPhrases({ activity: "thinking" }).phrases[0]).toBe("Thinking it through");
  });

  it("names the kind of work in plain words, never a file name or size", () => {
    expect(friendlyNowPhrases({ activity: "reply" }).phrases).toEqual(["Typing…"]);
    expect(friendlyNowPhrases({ activity: "command", itemId: "x" }).phrases).toEqual(["Running a few commands"]);
    expect(friendlyNowPhrases({ activity: "write", file: "index.html", bytes: 14_000, itemId: "w" }).phrases).toEqual(["Writing some code"]);
    expect(friendlyNowPhrases({ activity: "read", file: "notes.md", itemId: "r" }).phrases).toEqual(["Digging around"]);
    expect(friendlyNowPhrases({ activity: "web", itemId: "s" }).phrases).toEqual(["Digging around"]);
    expect(friendlyNowPhrases(null, running("Bash")).phrases).toEqual(["Running a few commands"]);
    expect(friendlyNowPhrases(null, running("mcp__computer__click")).phrases).toEqual(["Clicking around"]);
    expect(friendlyNowPhrases(null, running("delegate_bot")).phrases).toEqual(["Checking in with the team"]);
  });

  it("reads a step by its tool, not the narration the server writes for calls", () => {
    expect(friendlyNowPhrases(null, running("Bash", { spoken: "running a command" })).phrases).toEqual(["Running a few commands"]);
  });

  it("says the command, search or page the server could name, as Advanced does, and still no file names", () => {
    expect(friendlyNowPhrases({ activity: "command", itemId: "x", target: "scrape.py" }).phrases).toEqual(["Running scrape.py"]);
    expect(friendlyNowPhrases({ activity: "web", itemId: "s", target: "Biber Dammbau" }).phrases).toEqual(["Searching the web for “Biber Dammbau”"]);
    expect(friendlyNowPhrases(null, running("WebFetch", { step: { activity: "fetch", target: "linkedin.com" } })).phrases).toEqual(["Reading linkedin.com"]);
    expect(friendlyNowPhrases(null, running("Write", { step: { activity: "write", target: "report.md" } })).phrases).toEqual(["Writing some code"]);
  });

  it("says which outside service the bot is working in", () => {
    expect(toolService("mcp__notion__search")).toBe("Notion");
    expect(toolService("mcp__composio__GMAIL_SEND_EMAIL")).toBe("Gmail");
    expect(toolService("mcp__ogb__ask_user")).toBeNull();
    expect(toolService("Bash")).toBeNull();
    expect(friendlyNowPhrases(null, running("mcp__notion__search")).phrases).toEqual(["Working in Notion"]);
  });
});
