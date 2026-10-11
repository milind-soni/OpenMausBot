import { describe, expect, it } from "vitest";

import { queuedBehindPersonText, settledWaitingChip, UnansweredApprovals } from "./waiting-on-person.ts";

describe("the waiting-on-you chip once its card settles", () => {
  it.each([
    ["approval", "allow", "user", "@Mira got your approval", true],
    ["answer", "answer", "user", "@Mira got your answer", true],
    ["approval", "allow", "auto", "@Mira's request was approved", true],
    ["approval", "deny", "user", "@Mira's request was denied", false],
    ["answer", "deny", "user", "@Mira's question was dismissed", false],
    // The engine denies an approval nobody answered on its own timer.
    ["approval", "deny", "timeout", "Nobody answered @Mira's approval in time — that step did not run", false],
    // Claude files an unanswered question as an "answer" carrying its own note.
    ["answer", "answer", "timeout", "Nobody answered @Mira's question in time", false],
    // A turn ending or a restart closes the card; nobody approved anything.
    ["approval", "deny", "system", "@Mira's approval closed before anyone answered — that step did not run", false],
    ["approval", "deny", "unavailable", "@Mira's approval closed before anyone answered — that step did not run", false],
    // A question outlives its turn and can still be answered there.
    ["answer", "answer", "system", "@Mira's turn ended before anyone answered its question", false],
  ] as const)("a %s settled %s by %s reads %j", (kind, behavior, source, name, ok) => {
    expect(settledWaitingChip("Mira", kind, behavior, source)).toEqual({ name, ok });
  });
});

describe("work queued behind the person's card", () => {
  it("names whose card and where, in words that stay true once it is answered", () => {
    expect(queuedBehindPersonText("Mira", "approval", "@Clive · work")).toBe("Queued for @Mira behind your approval in “@Clive · work”");
    expect(queuedBehindPersonText("Mira", "question", "Release")).toBe("Queued for @Mira behind your answer in “Release”");
  });
});

describe("approvals nobody answered", () => {
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
    // a card no turn owns has no result to carry it, nor does a turnless result
    notes.record("t3", undefined, "Bash", "npm test");
    expect(notes.annotate("t3", undefined, "done", true)).toBe("done");
    expect(notes.annotate("t1", undefined, "done", true)).toBe("done");
  });

  it("drops an action once a later card of the turn for it is answered", () => {
    const notes = new UnansweredApprovals();
    notes.record("t1", "turn-1", "audit_write", "audit_write {\"name\":\"receipt\"}");
    notes.record("t1", "turn-1", "Bash", "npm test");
    // another turn's or another action's answer changes nothing
    notes.answered("t1", "turn-2", "Bash", "npm test");
    notes.answered("t1", "turn-1", "Bash", "npm run lint");
    expect(notes.annotate("t1", "turn-1", "done", true)).toContain("approvals for “audit_write {\"name\":\"receipt\"}”, “Bash: npm test”");
    // the model asked again once the person was back, and it was answered
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
