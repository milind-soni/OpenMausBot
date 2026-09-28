// Who hears about a broken run, how often, and in what words.
import { describe, expect, it } from "vitest";

import { chiefForBot, INCIDENT_HARD_LIMIT, INCIDENT_RETRY_LIMIT, IncidentLedger, incidentChip, incidentText, type Incident } from "./incidents.ts";

const bots = [
  { id: "clive", name: "Clive", section: "Ops", chiefOfStaff: true },
  { id: "ada", name: "Ada", section: "Ops" },
  { id: "ben", name: "Ben", section: "Research" },
  { id: "rita", name: "Rita", section: "Research", chiefOfStaff: true, hidden: true },
  { id: "maya", name: "Maya", section: "Sales", chiefOfStaff: true, managedSections: ["Research"] },
  { id: "solo", name: "Solo", section: "Alone" },
];

describe("chiefForBot", () => {
  it("picks the Chief of the bot's own section first, then a Chief allowed to coordinate it", () => {
    expect(chiefForBot(bots, bots[1]!)?.id).toBe("clive");
    // Research's own Chief is hidden; Maya may coordinate Research
    expect(chiefForBot(bots, bots[2]!)?.id).toBe("maya");
  });
  it("gives a Chief no Chief, and a section with none goes to the person", () => {
    expect(chiefForBot(bots, bots[0]!)).toBeNull();
    expect(chiefForBot(bots, bots[4]!)).toBeNull();
    expect(chiefForBot(bots, bots[5]!)).toBeNull();
  });
});

describe("IncidentLedger", () => {
  it("lets the Chief retry twice, then says so, then goes quiet on a crash loop", () => {
    let now = 1_000_000;
    const ledger = new IncidentLedger({ now: () => now });
    const seen = Array.from({ length: INCIDENT_HARD_LIMIT + 1 }, () => ledger.note("t1"));
    expect(seen.map((entry) => entry.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.map((entry) => entry.mayRetry)).toEqual([true, true, false, false, false, false]);
    expect(seen.map((entry) => entry.muted)).toEqual([false, false, false, false, false, true]);
    expect(INCIDENT_RETRY_LIMIT).toBe(2);
    // another thread is its own count; an hour later the first is fresh again
    expect(ledger.note("t2")).toEqual({ count: 1, mayRetry: true, muted: false });
    now += 61 * 60_000;
    expect(ledger.note("t1")).toEqual({ count: 1, mayRetry: true, muted: false });
    ledger.forget("t2");
    expect(ledger.note("t2").count).toBe(1);
  });
});

describe("incident wording", () => {
  const incident: Incident = {
    kind: "failed",
    bot: { id: "ada", name: "Ada", section: "Ops" },
    threadId: "t-ada",
    title: "Invoice reconciliation",
    detail: "exit_before_result",
    lastRequest: "Reconcile the September invoices.\n\nThanks",
    lastReply: "```\nlots of code\n```\nStarting the reconciliation now",
  };

  it("names the bot, the thread and what happened, marks the quoted text as data, and tells the Chief what to do", () => {
    const text = incidentText(incident, { count: 1, mayRetry: true, muted: false });
    expect(text.startsWith("[Incident report from OpenMausBot — not from the person.")).toBe(true);
    expect(text).toContain("Ada's run in its thread #Invoice reconciliation failed: \"exit_before_result\".");
    expect(text).toContain('The request there was: "Reconcile the September invoices. Thanks"');
    expect(text).toContain('Ada last said: "Starting the reconciliation now"');
    expect(text).toContain('retry_thread with bot_id "ada" and thread_id "t-ada"');
    expect(text).not.toContain("incident on that thread");
    expect(incidentChip(incident)).toBe('Incident: Ada\'s run in its thread #Invoice reconciliation failed: "exit_before_result"');
  });

  it("counts repeats and, once retries are used up, asks for the person instead of another retry", () => {
    const second = incidentText(incident, { count: 2, mayRetry: true, muted: false });
    expect(second).toContain("This is the second incident on that thread within the hour.");
    expect(second).toContain("retry_thread");
    const third = incidentText(incident, { count: 3, mayRetry: false, muted: false });
    expect(third).toContain("Retries for that thread are used up.");
    expect(third).not.toContain("call retry_thread");
  });

  it("words a stall, a start failure, a routine and a room each in their own terms", () => {
    expect(incidentChip({ ...incident, kind: "stalled", detail: "" })).toBe("Incident: Ada's run in its thread #Invoice reconciliation stopped after showing no activity");
    expect(incidentChip({ ...incident, kind: "could-not-start", title: null })).toContain("Ada's run in its main conversation could not start");
    expect(incidentChip({ ...incident, kind: "routine-failed", title: "Inbox digest" })).toContain("Ada's scheduled routine in its thread #Inbox digest failed");
    expect(incidentChip({ ...incident, room: "Standup" })).toContain('Ada\'s run in the room "Standup" failed');
  });
});
