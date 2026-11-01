import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { nowSteps, quietText, stepLabel } from "./now-steps";

let id = 0;
const ask = (text: string, extra: Partial<Message> = {}): Message => ({ id: `u${++id}`, role: "user", kind: "text", at: id, text, ...extra });
const call = (name: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id: `a${++id}`, role: "bot", kind: "activity", at: id, tool: { name, itemId: `item-${id}`, ...tool } });

describe("the Now card's steps", () => {
  it("lists the current ask's calls in order: done in the past tense, the running one as the line says it", () => {
    const messages = [
      ask("Old question"),
      call("Bash", { ok: true, step: { activity: "command", target: "ls" } }),
      ask("Find construction leads for Acme"),
      call("WebSearch", { ok: true, step: { activity: "web", target: "Acme construction leads" } }),
      call("WebFetch", { ok: true, step: { activity: "fetch", target: "linkedin.com", detail: "linkedin.com/company/acme" } }),
      call("Bash", { ok: false }),
      ask("and hurry", { steered: true }),
      call("Bash", { step: { activity: "command", target: "scrape.py", detail: "python3 scrape.py --pages 40" } }),
    ];
    expect(nowSteps(messages, null).map(({ label, state, hover }) => ({ label, state, hover }))).toEqual([
      { label: "Searched the web for “Acme construction leads”", state: "done", hover: undefined },
      { label: "Read linkedin.com", state: "done", hover: "linkedin.com/company/acme" },
      { label: "Ran a command", state: "failed", hover: undefined },
      { label: "Running scrape.py", state: "now", hover: "python3 scrape.py --pages 40" },
    ]);
  });

  it("keeps the last few, leaves out notices and team chips, and adds the live call the chat has no row for yet", () => {
    const messages = [
      ask("Build the report"),
      ...Array.from({ length: 5 }, (_, n) => call("Read", { ok: true, step: { activity: "read", target: `notes-${n}.md` } })),
      { id: "notice", role: "bot", kind: "activity", at: 99, tool: { name: "Approve for me: …", ok: true } } as Message,
      { ...call("ask_bot", { ok: true }), comm: { groupId: "g", withBotId: "b", withName: "Kai", withColor: "blue" } } as Message,
    ];
    const steps = nowSteps(messages, { activity: "write", itemId: "w1", file: "report.md", bytes: 9_000 });
    expect(steps.map((step) => step.label)).toEqual(["Read notes-2.md", "Read notes-3.md", "Read notes-4.md", "Writing report.md"]);
    expect(steps.at(-1)?.state).toBe("now");
  });

  it("says a finished step it cannot name in plain past words, and keeps an unknown tool's own label", () => {
    expect(stepLabel({ name: "Bash", ok: true }, "done")).toBe("Ran a command");
    expect(stepLabel({ name: "Grep", ok: true }, "done")).toBe("Searched files");
    expect(stepLabel({ name: "mcp__agents__ask_bot", ok: true }, "done")).toBe("Asking a teammate");
  });

  it("says whose own app a step used, running or done", () => {
    const whose = { person: "Ada", app: "Notion" };
    expect(stepLabel({ name: "mcp__own_apps__NOTION_SEARCH", ok: true, whose }, "done")).toMatch(/ · using Ada's Notion$/);
    expect(stepLabel({ name: "mcp__own_apps__NOTION_SEARCH", whose }, "now")).toMatch(/ · using Ada's Notion$/);
    expect(stepLabel({ name: "mcp__own_apps__NOTION_SEARCH", ok: true }, "done")).not.toContain("using");
  });
});

describe("a long step's sign of life", () => {
  it("counts the time since its last output, and says what its processes show while it has printed nothing", () => {
    const at = 1_000_000;
    expect(quietText({ kind: "output", at }, at + 20_000)).toBe("last output just now");
    expect(quietText({ kind: "output", at }, at + 2 * 60_000 + 5_000)).toBe("last output 2 min ago");
    expect(quietText({ kind: "output", at }, at + 3 * 60 * 60_000)).toBe("last output 3 h ago");
    expect(quietText({ kind: "network" }, at)).toBe("waiting on the network");
    expect(quietText({ kind: "busy" }, at)).toBe("busy, no output yet");
    expect(quietText({ kind: "idle" }, at)).toBe("idle, no output yet");
    expect(quietText(undefined, at)).toBeUndefined();
  });
});
