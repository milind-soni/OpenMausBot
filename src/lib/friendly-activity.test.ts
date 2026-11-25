import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { friendlyNowPhrases, madeKey, taskSubject, toolService } from "./friendly-activity";

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
    expect(friendlyNowPhrases({ activity: "write", file: "scrape.py", bytes: 14_000, itemId: "w" }).phrases).toEqual(["Writing some code"]);
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
    expect(friendlyNowPhrases({ activity: "web", itemId: "s", target: "Acme construction leads" }).phrases).toEqual(["Searching the web for “Acme construction leads”"]);
    expect(friendlyNowPhrases(null, running("WebFetch", { step: { activity: "fetch", target: "linkedin.com" } })).phrases).toEqual(["Reading linkedin.com"]);
    expect(friendlyNowPhrases(null, running("Write", { step: { activity: "write", target: "report.md" } })).phrases).toEqual(["Writing it up"]);
  });

  it("says which outside service the bot is working in", () => {
    expect(toolService("mcp__notion__search")).toBe("Notion");
    expect(toolService("mcp__composio__GMAIL_SEND_EMAIL")).toBe("Gmail");
    expect(toolService("mcp__ogb__ask_user")).toBeNull();
    expect(toolService("Bash")).toBeNull();
    expect(friendlyNowPhrases(null, running("mcp__notion__search")).phrases).toEqual(["Working in Notion"]);
  });

  it("says what a page or write-up makes, never the file's name", () => {
    expect(friendlyNowPhrases({ activity: "write", file: "lisbon.html", bytes: 14_000, itemId: "w" }).phrases).toEqual(["Putting the page together"]);
    expect(friendlyNowPhrases({ activity: "edit", target: "site/INDEX.HTM", itemId: "e" }).phrases).toEqual(["Putting the page together"]);
    expect(friendlyNowPhrases({ activity: "write", file: "lisbon-food-trip.md", itemId: "w" }).phrases).toEqual(["Writing it up"]);
    expect(friendlyNowPhrases(null, running("Write", { step: { activity: "write", target: "plan.docx" } })).phrases).toEqual(["Writing it up"]);
    expect(friendlyNowPhrases({ activity: "write", file: "build.py", itemId: "w" }).phrases).toEqual(["Writing some code"]);
    // The engine's report wins over a call still showing in the chat, as for the rest of the line.
    expect(friendlyNowPhrases({ activity: "thinking" }, running("Write", { step: { activity: "write", target: "page.html" } })).phrases[0]).toBe("Thinking it through");
    // A finished call says nothing about now.
    expect(madeKey(null, running("Write", { ok: true, step: { activity: "write", target: "page.html" } }))).toBeNull();
  });

  it("names the conversation's work in place of words that only name the tool", () => {
    const subject = "Lisbon food trip";
    expect(friendlyNowPhrases(null, undefined, subject)).toEqual({ phase: "friendly:task:Lisbon food trip", phrases: ["Working on Lisbon food trip"] });
    expect(friendlyNowPhrases({ activity: "thinking" }, undefined, subject).phrases).toEqual(["Working on Lisbon food trip"]);
    expect(friendlyNowPhrases({ activity: "write", file: "build.py", itemId: "w" }, undefined, subject).phrases).toEqual(["Working on Lisbon food trip"]);
    expect(friendlyNowPhrases({ activity: "command", itemId: "x" }, undefined, subject).phrases).toEqual(["Working on Lisbon food trip"]);
    expect(friendlyNowPhrases(null, running("Bash"), subject).phrases).toEqual(["Working on Lisbon food trip"]);
    // What says more than the tool stays: a page, a search, a reply, a service, the team.
    expect(friendlyNowPhrases({ activity: "write", file: "lisbon.html", itemId: "w" }, undefined, subject).phrases).toEqual(["Putting the page together"]);
    expect(friendlyNowPhrases({ activity: "web", itemId: "s", target: "pastelarias Belém" }, undefined, subject).phrases).toEqual(["Searching the web for “pastelarias Belém”"]);
    expect(friendlyNowPhrases({ activity: "read", file: "notes.md", itemId: "r" }, undefined, subject).phrases).toEqual(["Digging around"]);
    expect(friendlyNowPhrases({ activity: "reply" }, undefined, subject).phrases).toEqual(["Typing…"]);
    expect(friendlyNowPhrases(null, running("delegate_bot"), subject).phrases).toEqual(["Checking in with the team"]);
    expect(friendlyNowPhrases(null, running("mcp__notion__search"), subject).phrases).toEqual(["Working in Notion"]);
  });

  it("takes the conversation's title as its work only once it is more than a stand-in", () => {
    const asked = ["Plan a 2-day food trip to Lisbon: where to eat, what to order. Give me something I can keep and share."];
    expect(taskSubject("Lisbon two-day food trip", asked)).toBe("Lisbon two-day food trip");
    expect(taskSubject("Plan a 2-day food trip to Lisbon: where to eat, w…", asked)).toBeUndefined();
    expect(taskSubject("Plan a 2-day food trip to Lisbon", asked)).toBeUndefined();
    expect(taskSubject("Pasted notes for the trip", ['<pasted-text index="1">\nPasted notes for the trip\n</pasted-text>'])).toBeUndefined();
    expect(taskSubject("New task", [])).toBeUndefined();
    expect(taskSubject("New thread", [])).toBeUndefined();
    expect(taskSubject("  ", [])).toBeUndefined();
    expect(taskSubject(undefined, asked)).toBeUndefined();
  });
});
