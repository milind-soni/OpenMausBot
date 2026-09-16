// The recent-work brief: which conversations count as a bot's, how the
// newest line from each is worded, what a finished turn leaves in the log.
import { describe, expect, it } from "vitest";

import {
  botThreads,
  parseSince,
  recentWorkLines,
  recentWorkPrompt,
  RECENT_WORK_MAX_CHARS,
  turnOutcomeLine,
  whenLabel,
  type RecentWorkStore,
} from "./recent-work.ts";
import type { GroupRecord, TaskRecord } from "./store.ts";

const task = (threadId: string, title: string): TaskRecord => ({ threadId, title, createdAt: 1, resumeCursors: {} } as TaskRecord);
const group = (partial: Partial<GroupRecord> & Pick<GroupRecord, "id" | "threadId" | "name" | "memberIds">): GroupRecord =>
  ({ defaultResponder: { kind: "user" }, bulletin: "", unread: false, createdAt: 1, ...partial } as GroupRecord);

const store: RecentWorkStore = {
  groups: [
    group({ id: "g1", threadId: "room-ops", name: "Ops", memberIds: ["me", "them"], tasks: [{ threadId: "room-ops-t1", title: "Deploy day", createdAt: 1 }] }),
    group({ id: "g2", threadId: "room-other", name: "Not mine", memberIds: ["them"] }),
    group({ id: "g3", threadId: "dm-them", name: "DM", memberIds: ["me", "them"], dm: true }),
  ],
  taskByThread: (botId, threadId) => (botId === "me" && threadId === "main" ? task("main", "Getting started") : undefined),
};
const me = { id: "me", threadId: "main", tasks: [task("t-inv", "Invoice reconciliation"), task("t-inv", "duplicate id")] };

describe("botThreads", () => {
  it("lists the main chat, tasks, and the rooms the bot belongs to, each named for the bot", () => {
    expect(botThreads(store, me, "Milind")).toEqual([
      { threadId: "main", where: "1:1 with Milind", title: "Getting started", private: true },
      { threadId: "t-inv", where: "1:1 with Milind", title: "Invoice reconciliation", private: true },
      { threadId: "room-ops", where: 'room "Ops"', title: null, private: false },
      { threadId: "room-ops-t1", where: 'room "Ops"', title: "Deploy day", private: false },
      // a DM room is private the way a 1:1 is
      { threadId: "dm-them", where: 'room "DM"', title: null, private: true },
    ]);
  });
});

describe("recentWorkLines + recentWorkPrompt", () => {
  const now = new Date(2026, 8, 16, 10, 30).getTime();
  const threads = botThreads(store, me, "Milind");

  it("joins what was said to where, newest first, and words the brief for a standup", () => {
    const lines = recentWorkLines(threads, [
      { threadId: "t-inv", messageId: "m2", at: new Date(2026, 8, 16, 9, 5).getTime(), head: "Sent the three flagged invoices to finance; two are still missing a PO." },
      { threadId: "room-ops", messageId: "m1", at: new Date(2026, 8, 15, 17, 40).getTime(), head: "I'll take the deploy tomorrow morning." },
      { threadId: "unknown", messageId: "m0", at: now, head: "not one of mine" },
      { threadId: "main", messageId: "m9", at: new Date(2026, 8, 10, 8, 0).getTime(), head: "" },
    ]);
    expect(lines.map((line) => line.threadId)).toEqual(["t-inv", "room-ops"]);
    expect(lines[0]).toMatchObject({ where: "1:1 with Milind", title: "Invoice reconciliation", private: true });
    const text = recentWorkPrompt(lines, now);
    expect(text).toContain("Your recent work");
    expect(text).toContain('- today 09:05 · 1:1 with Milind · "Invoice reconciliation" · you said: "Sent the three flagged invoices to finance; two are still missing a PO."');
    expect(text).toContain('- yesterday 17:40 · room "Ops" · you said: "I\'ll take the deploy tomorrow morning."');
    expect(text).toContain("session_search with since");
    expect(recentWorkPrompt([], now)).toBe("");
  });

  it("folds long lines and stays inside the prompt budget", () => {
    const lines = recentWorkLines(threads, Array.from({ length: 10 }, (_, index) => ({
      threadId: "t-inv",
      messageId: `m${index}`,
      at: now - index,
      head: "word ".repeat(200),
    })));
    // one thread → one line, however many messages it has
    expect(lines).toHaveLength(1);
    expect(lines[0]!.said.length).toBeLessThanOrEqual(160);
    expect(lines[0]!.said.endsWith("…")).toBe(true);
    const many = recentWorkLines(
      Array.from({ length: 30 }, (_, index) => ({ threadId: `t${index}`, where: "1:1 with Milind", title: `Task ${index}`, private: true })),
      Array.from({ length: 30 }, (_, index) => ({ threadId: `t${index}`, messageId: `m${index}`, at: now - index, head: "x".repeat(150) })),
    );
    expect(many).toHaveLength(10);
    const text = recentWorkPrompt(many, now);
    expect(text.length).toBeLessThan(RECENT_WORK_MAX_CHARS + 600);
    expect(text.split("\n- ").length - 1).toBeLessThan(10);
  });

  it("says today, yesterday, or the date", () => {
    expect(whenLabel(new Date(2026, 8, 16, 7, 3).getTime(), now)).toBe("today 07:03");
    expect(whenLabel(new Date(2026, 8, 15, 23, 59).getTime(), now)).toBe("yesterday 23:59");
    expect(whenLabel(new Date(2026, 8, 14, 12, 0).getTime(), now)).toBe("2026-09-14 12:00");
  });
});

describe("turnOutcomeLine", () => {
  it("notes what was said and the tools used; a failed turn says so; a silent fine turn leaves nothing", () => {
    expect(turnOutcomeLine({ ok: true, reply: "Done.\n\nSent 3 invoices.", tools: ["Bash", "Bash", "browser_click"] }))
      .toBe("Done. Sent 3 invoices. [tools: Bash, browser_click]");
    expect(turnOutcomeLine({ ok: false, reply: null, stopReason: "provider exited", tools: [] }))
      .toBe("(turn failed: provider exited) no reply");
    expect(turnOutcomeLine({ ok: true, reply: "", tools: [] })).toBeNull();
    expect(turnOutcomeLine({ ok: true, reply: "x".repeat(500), tools: [] })!.length).toBeLessThanOrEqual(240);
  });
});

describe("parseSince", () => {
  const now = new Date(2026, 8, 16, 10, 30).getTime();
  it("reads spans, day words, epochs and dates; refuses the rest", () => {
    expect(parseSince("24h", now)).toBe(now - 86_400_000);
    expect(parseSince(" 3d ", now)).toBe(now - 3 * 86_400_000);
    expect(parseSince("2w", now)).toBe(now - 14 * 86_400_000);
    expect(parseSince("today", now)).toBe(new Date(2026, 8, 16).getTime());
    expect(parseSince("Yesterday", now)).toBe(new Date(2026, 8, 15).getTime());
    expect(parseSince(String(now), now)).toBe(now);
    expect(parseSince("2026-09-01T00:00:00Z", now)).toBe(Date.UTC(2026, 8, 1));
    expect(parseSince("soon", now)).toBeNull();
    expect(parseSince("", now)).toBeNull();
  });

  it("reads a bare date as the start of that local day, like yesterday and other typed dates", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const localNow = new Date(2026, 8, 16, 10, 30).getTime();
      expect(parseSince("2026-09-15", localNow)).toBe(new Date(2026, 8, 15).getTime());
      expect(parseSince("2026-09-15", localNow)).toBe(parseSince("yesterday", localNow));
      expect(parseSince("2026-09-15", localNow)).toBe(parseSince("2026-09-15 00:00", localNow));
      expect(parseSince("2026-09-01T00:00:00Z", localNow)).toBe(Date.UTC(2026, 8, 1));
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
