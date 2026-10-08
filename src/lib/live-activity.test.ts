import { describe, expect, it } from "vitest";

import { activityStepLabel, liveActivityLabel } from "./live-activity";
import type { Message } from "@/state/store";

const activity = (name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: "activity",
  at: 1,
  role: "bot",
  kind: "activity",
  tool: { ...extra, name },
});

describe("liveActivityLabel", () => {
  it("shows thinking before a tool starts and after it settles", () => {
    expect(liveActivityLabel()).toBe("Thinking");
    expect(liveActivityLabel(activity("Read", { ok: true }))).toBe("Thinking");
  });

  it("uses the server's narration for the exact live action", () => {
    expect(liveActivityLabel(activity("Edit", { spoken: "editing a file" }))).toBe(
      "Editing a file",
    );
  });

  it("maps common native and MCP tool names when narration is unavailable", () => {
    expect(liveActivityLabel(activity("Bash: pnpm test"))).toBe("Running a command");
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("Using the computer");
    expect(liveActivityLabel(activity("web_search"))).toBe("Searching the web");
    expect(liveActivityLabel(activity("delegate_bot"))).toBe("Handing off a task");
    expect(liveActivityLabel(activity("ask_bot"))).toBe("Asking a teammate");
    expect(liveActivityLabel(activity("list_rooms"))).toBe("Checking the groups");
    expect(liveActivityLabel(activity("post_to_room"))).toBe("Posting in a group");
  });

  it("does not present bot-to-bot communication chips as the active action", () => {
    expect(
      liveActivityLabel({
        ...activity("ask_bot"),
        comm: { groupId: "room", withBotId: "bot", withName: "Peer", withColor: "blue" },
      }),
    ).toBe("Thinking");
  });
});

describe("activityStepLabel", () => {
  it("names a step the way the working line does: the server's narration first", () => {
    expect(activityStepLabel({ name: "Edit", spoken: "editing a file" })).toBe("Editing a file");
    expect(activityStepLabel({ name: "mcp__computer__click" })).toBe("Using the computer");
  });

  it("never shows a step's arguments", () => {
    expect(activityStepLabel({ name: "Bash: rm -rf ~/private" })).toBe("Running a command");
    expect(activityStepLabel({ name: "make_invoice" })).toBe("Working");
  });

  it("names a step by its tool alone, whatever its arguments say", () => {
    expect(activityStepLabel({ name: "make_invoice: read the file" })).toBe("Working");
  });

  // "Edit" and "editing a file" give the same words, so the first test cannot
  // tell narration from a label made of the name. These two can.
  it("prefers the narration to the label the tool's name would give", () => {
    expect(activityStepLabel({ name: "Bash", spoken: "checking the build." })).toBe("Checking the build");
  });

  it("falls back to the tool's name when the narration is blank", () => {
    expect(activityStepLabel({ name: "Bash", spoken: "   " })).toBe("Running a command");
  });
});
