import { describe, expect, it } from "vitest";
import { isPureLeakedSystemHarnessMessage, stripLeakedSystemHarnessMessages } from "./system-message-guard.ts";

describe("system-message-guard", () => {
  it("leaves ordinary conversational text alone", () => {
    const text = "Hello! Here is the summary of your task.";
    expect(stripLeakedSystemHarnessMessages(text)).toBe(text);
    expect(isPureLeakedSystemHarnessMessage(text)).toBe(false);
  });

  it("handles null and undefined safely", () => {
    expect(stripLeakedSystemHarnessMessages(null)).toBe("");
    expect(stripLeakedSystemHarnessMessages(undefined)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(null)).toBe(false);
    expect(isPureLeakedSystemHarnessMessage(undefined)).toBe(false);
  });

  it("strips raw leaked background task notifications", () => {
    const leaked = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE> [Message] timestamp=2026-10-10T18:01:21Z
sender=a3cf0f98-46dc-449c-9867-68dfa3d6d3db/task-1457
priority=MESSAGE_PRIORITY_HIGH content=Task id "a3cf0f98-46dc-449c-9867-68dfa3d6d3db/task-1457" finished with result:

The command exited with code 0. Stdout:

Stderr:

Log:
file:///Users/jsmhh/.openmausbot/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/brain/a3cf0f98-46dc-449c-9867-68dfa3d6d3db/.system_generated/tasks/task-1457.log </SYSTEM_MESSAGE>`;

    expect(stripLeakedSystemHarnessMessages(leaked)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(leaked)).toBe(true);
  });

  it("preserves genuine assistant text while stripping leaked system block", () => {
    const mixed = `I've started building the feature for you.

The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE> Task id 123 finished with exit code 0 </SYSTEM_MESSAGE>

Everything compiled successfully and all tests pass!`;

    const cleaned = stripLeakedSystemHarnessMessages(mixed);
    expect(cleaned).toContain("I've started building the feature for you.");
    expect(cleaned).toContain("Everything compiled successfully and all tests pass!");
    expect(cleaned).not.toContain("<SYSTEM_MESSAGE>");
    expect(cleaned).not.toContain("Task id 123");
    expect(isPureLeakedSystemHarnessMessage(mixed)).toBe(false);
  });

  it("strips unclosed system tags during streaming / truncation", () => {
    const unclosed = `The following is a <SYSTEM_MESSAGE> not actually sent by the user.
<SYSTEM_MESSAGE> [Message] timestamp=2026-10-10T18:00:00Z task still in progress`;

    expect(stripLeakedSystemHarnessMessages(unclosed)).toBe("");
    expect(isPureLeakedSystemHarnessMessage(unclosed)).toBe(true);
  });
});
