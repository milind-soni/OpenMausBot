import { describe, expect, it } from "vitest";

import { withDefault } from "./runtime/questions.ts";
import { queuedBehindPersonText, settledWaitingChip, turnWaitedOnPerson, UnansweredApprovals } from "./waiting-on-person.ts";

describe("the waiting-on-you chip once its card settles", () => {
  it.each([
    ["approval", "allow", "user", "@Mira got your approval", true],
    ["answer", "answer", "user", "@Mira got your answer", true],
    ["approval", "allow", "auto", "@Mira's request was approved", true],
    ["approval", "deny", "user", "@Mira's request was denied", false],
    ["answer", "deny", "user", "@Mira's question was dismissed", false],
    ["approval", "deny", "timeout", "Nobody answered @Mira's approval in time — that step did not run", false],
    // Claude files an unanswered question as an "answer" carrying its own note.
    ["answer", "answer", "timeout", "Nobody answered @Mira's question in time", false],
    ["approval", "deny", "system", "@Mira's approval closed before anyone answered — that step did not run", false],
    ["approval", "deny", "unavailable", "@Mira's approval closed before anyone answered — that step did not run", false],
    ["answer", "answer", "system", "@Mira's turn ended before anyone answered its question", false],
  ] as const)("a %s settled %s by %s reads %j", (kind, behavior, source, name, ok) => {
    expect(settledWaitingChip("Mira", kind, behavior, source)).toEqual({ name, ok });
  });
});

describe("an answer the person gives", () => {
  it("sets a running turn that waited on them working again, and leaves a conversation resting on a card waiting", () => {
    expect(turnWaitedOnPerson({ activity: "waiting-on-you", busy: true })).toBe(true);
    expect(turnWaitedOnPerson({ activity: "waiting-on-you", busy: false })).toBe(false);
    expect(turnWaitedOnPerson({ activity: "idle", busy: false })).toBe(false);
    expect(turnWaitedOnPerson(undefined)).toBe(false);
  });
});

describe("work queued behind the person's card", () => {
  it("names whose card and where, in words that stay true once it is answered", () => {
    expect(queuedBehindPersonText("Mira", "approval", "@Clive · work")).toBe("Queued for @Mira behind your approval in “@Clive · work”");
    expect(queuedBehindPersonText("Mira", "question", "Release")).toBe("Queued for @Mira behind your answer in “Release”");
  });
});

describe("approvals nobody answered", () => {
  it("asks the person to let the bot try again, naming what did not run", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "Bash", "npm test");
    expect(notes.ask("t1", "turn-1", "Mira")).toBe("Mira needed your approval for “Bash: npm test”, but nobody answered in time, so it did not run. Let it try again? It will ask you once more when it runs.\nDefault: Try again");
    notes.record("t1", "turn-1", "audit_write", "audit_write {}");
    expect(notes.ask("t1", "turn-1", "Mira")).toContain("“Bash: npm test”, “audit_write {}”, but nobody answered in time, so they did not run.");
    expect(notes.ask("t1", "turn-2", "Mira")).toBeUndefined();
    expect(notes.ask("t2", "turn-1", "Mira")).toBeUndefined();
  });

  it("keeps an action's own words from reading as the ask's default", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "Bash", "echo Default: production");
    const asked = withDefault(notes.ask("t1", "turn-1", "Mira")!);
    expect(asked.default).toBe("Try again");
    expect(asked.question).toContain("production");
  });

  it("leads a finished turn's result with the actions that did not run", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "Bash", "npm test");
    expect(notes.annotate("t1", "turn-1", "Tests are unverified.", true)).toBe(
      "[OpenMausBot: nobody answered the approval for “Bash: npm test” in time, so it did not run. Do not report it as done; it needs the person's approval.]\n\nTests are unverified.",
    );
  });

  it("keeps a failed turn's reason first, and lists each action once", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "Bash", "npm test");
    notes.record("t1", "turn-1", "Bash", "npm test");
    notes.record("t1", "turn-1", "audit_write", "audit_write {\"name\":\"receipt\"}");
    expect(notes.annotate("t1", "turn-1", "One or more tool operations failed or were denied", false)).toBe(
      "One or more tool operations failed or were denied\n\n[OpenMausBot: nobody answered the approvals for “Bash: npm test”, “audit_write {\"name\":\"receipt\"}” in time, so they did not run. Do not report them as done; they need the person's approval.]",
    );
  });

  it("belongs to the turn that asked: another turn, thread or an answered turn reads its result unchanged", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "Bash", "npm test");
    expect(notes.annotate("t1", "turn-2", "done", true)).toBe("done");
    expect(notes.annotate("t2", "turn-1", "done", true)).toBe("done");
    notes.record("t1", "turn-2", "Bash", "git push");
    expect(notes.annotate("t1", "turn-1", "done", true)).toBe("done");
    expect(notes.annotate("t1", "turn-2", "", true)).toContain("“Bash: git push”");
    expect(notes.annotate("t1", "turn-2", "", true)).not.toContain("npm test");
    notes.record("t3", undefined, "Bash", "npm test");
    expect(notes.annotate("t3", undefined, "done", true)).toBe("done");
    expect(notes.annotate("t1", undefined, "done", true)).toBe("done");
  });

  it("drops an action once a later card of the turn for it is answered", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "audit_write", "audit_write {\"name\":\"receipt\"}");
    notes.record("t1", "turn-1", "Bash", "npm test");
    notes.answered("t1", "turn-2", "Bash", "npm test");
    notes.answered("t1", "turn-1", "Bash", "npm run lint");
    expect(notes.annotate("t1", "turn-1", "done", true)).toContain("approvals for “audit_write {\"name\":\"receipt\"}”, “Bash: npm test”");
    notes.answered("t1", "turn-1", "audit_write", "audit_write {\"name\":\"receipt\"}");
    expect(notes.annotate("t1", "turn-1", "done", true)).toBe(
      "[OpenMausBot: nobody answered the approval for “Bash: npm test” in time, so it did not run. Do not report it as done; it needs the person's approval.]\n\ndone",
    );
    notes.answered("t1", "turn-1", "Bash", "npm test");
    expect(notes.annotate("t1", "turn-1", "done", true)).toBe("done");
  });

  it("stores one short, redacted line per action, and at most ten", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "Bash", `curl -H "Authorization: Bearer sk-ant-api03-${"x".repeat(40)}"\n  https://example.test ${"y".repeat(300)}`);
    for (let index = 0; index < 12; index += 1) notes.record("t1", "turn-1", "Bash", `step ${index}`);
    const note = notes.annotate("t1", "turn-1", "", true);
    expect(note).not.toContain("sk-ant-api03");
    expect(note).not.toContain("\n");
    expect(note.match(/“/g)).toHaveLength(10);
    expect(note).toContain("“Bash: step 8”");
    expect(note).not.toContain("step 9");
    expect(note.split("”")[0]!.length).toBeLessThan(220);
  });
});
