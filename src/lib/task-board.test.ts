// The board's decisions, without a DOM.
//
// These tests exist because the same handful of judgements come up in three
// places — the filter, the columns, and the buttons — and the expensive
// failures are the ones where they disagree: a card filed under a team while
// its badge says another, a drop that writes an order landing the card where
// nobody aimed it, or a Run button that is live on a card that cannot run.
import { describe, expect, it } from "vitest";

import {
  WORK_COLUMNS,
  cardDay,
  cardMark,
  cardSection,
  cardStatusLabel,
  cardsByDay,
  columnsOf,
  dayLabel,
  dropPatch,
  elapsedLabel,
  filterByDay,
  filterByTeam,
  isOverdue,
  isPastDay,
  isToday,
  orderBetween,
  placeIn,
  relativeDays,
  runAvailability,
  runIsLive,
  statusTone,
  stopAvailability,
  type BoardCard,
} from "./task-board";

let seq = 0;

/** A card, with only the fields a test cares about spelled out. */
const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: `c${++seq}`,
  title: "A job",
  status: "todo",
  order: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

/** A card owned by a bot filed under `section`. */
const owned = (section: string, over: Partial<BoardCard> = {}): BoardCard =>
  card({
    ownerBotId: "bot-1",
    agent: { id: "bot-1", name: "Worker", section },
    ...over,
  });

describe("cardSection", () => {
  it("files a card under its owner's team", () => {
    expect(cardSection(owned("Alpha"))).toBe("Alpha");
  });

  it("puts a card with no owner in the unsectioned team", () => {
    // Not in EVERY team: a card that appears in two teams at once is the one
    // thing the switcher must never do.
    expect(cardSection(card())).toBe("");
  });

  it("treats a hidden owner's card as unsectioned, exactly as the server does", () => {
    // The badge and the filter read the same answer, so a hidden owner's card
    // cannot claim a team it is no longer shown in.
    const hidden = card({
      ownerBotId: "bot-1",
      agent: { id: "bot-1", name: "Ghost", section: "Alpha", hidden: true },
    });
    expect(cardSection(hidden)).toBe("");
  });

  it("ignores surrounding whitespace so a padded section is not its own team", () => {
    expect(cardSection(owned("  Alpha  "))).toBe("Alpha");
  });
});

describe("filterByTeam", () => {
  const alpha = owned("Alpha", { title: "alpha work" });
  const beta = owned("Beta", { title: "beta work" });
  const loose = card({ title: "loose work" });

  it("shows only the named team's cards", () => {
    expect(filterByTeam([alpha, beta, loose], "Alpha")).toEqual([alpha]);
  });

  it("shows the unsectioned cards for the empty team, which is a real selection", () => {
    // "" is not "no filter" — it is the team a bot lands in when nobody filed
    // it, and it must be reachable.
    expect(filterByTeam([alpha, beta, loose], "")).toEqual([loose]);
  });

  it("shows everything when no team is selected", () => {
    expect(filterByTeam([alpha, beta, loose], null)).toHaveLength(3);
  });
});

describe("columnsOf", () => {
  it("has a column for every status, in board order", () => {
    const columns = columnsOf([]);
    expect(Object.keys(columns)).toEqual([...WORK_COLUMNS]);
    expect(WORK_COLUMNS[0]).toBe("backlog");
  });

  it("orders a column by the order a drop writes, not by when the card was made", () => {
    const second = card({ order: 2, createdAt: 500 });
    const first = card({ order: 1, createdAt: 9_000 });
    expect(columnsOf([second, first]).todo.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("keeps a card whose status this client does not know rather than dropping it", () => {
    const stranger = card({ status: "shipping" as BoardCard["status"] });
    // Losing work off the board because a newer server used a status this
    // build has never heard of would be far worse than showing it misplaced.
    expect(columnsOf([stranger]).backlog.map((c) => c.id)).toEqual([stranger.id]);
  });
});

describe("orderBetween", () => {
  it("places a card below the one it follows", () => {
    expect(orderBetween(undefined, card({ order: 5 }))).toBe(4);
  });

  it("places a card above the one it precedes", () => {
    expect(orderBetween(card({ order: 5 }), undefined)).toBe(6);
  });

  it("places a card between its neighbours without renumbering them", () => {
    // Sparse on purpose: a drop writes one number, so the rest of the column
    // is untouched.
    expect(orderBetween(card({ order: 2 }), card({ order: 4 }))).toBe(3);
  });

  it("handles an empty column", () => {
    expect(orderBetween(undefined, undefined)).toBe(0);
  });
});

describe("dropPatch", () => {
  const a = card({ order: 0, title: "a" });
  const b = card({ order: 1, title: "b" });
  const c = card({ order: 2, title: "c" });

  it("writes an order between the two neighbours at the drop point", () => {
    // c dropped between a and b: its new order must land it there.
    expect(dropPatch([a, b, c], c.id, b.id)).toEqual({ order: 0.5 });
  });

  it("writes an order that puts the card last when dropped past the end", () => {
    expect(dropPatch([a, b, c], a.id, null)).toEqual({ order: 3 });
  });

  it("refuses a drop that would not change anything", () => {
    // Dropping a card onto its own position must not produce a write.
    expect(dropPatch([a, b, c], b.id, c.id)).toBeNull();
  });

  it("ignores a card that is not in the column", () => {
    expect(dropPatch([a, b, c], "not-here", null)).toBeNull();
  });

  it("ignores a drop point that no longer exists", () => {
    expect(dropPatch([a, b, c], a.id, "gone")).toBeNull();
  });
});

describe("runAvailability", () => {
  it("allows a card with an idle bot", () => {
    expect(runAvailability(owned("Alpha"))).toEqual({ canRun: true });
  });

  it("explains that a card needs an agent before it can start", () => {
    const result = runAvailability(card());
    expect(result.canRun).toBe(false);
    expect(result.canRun === false && result.reason).toBeTruthy();
  });

  it("explains that the assigned bot is gone", () => {
    const orphan = card({ ownerBotId: "bot-1", agent: null });
    const result = runAvailability(orphan);
    expect(result.canRun).toBe(false);
    expect(result.canRun === false && result.reason).toBeTruthy();
  });

  it("explains that the bot is already on this card instead of silently doing nothing", () => {
    // The likeliest source of "the button is broken" reports, so it has to
    // name the reason rather than behaving like the needs-an-agent case.
    const busy = owned("Alpha", { agent: { id: "bot-1", name: "Worker", section: "Alpha", busy: true } });
    const result = runAvailability(busy);
    expect(result.canRun).toBe(false);
    const reason = result.canRun === false ? result.reason : "";
    const idleReason = runAvailability(owned("Alpha"));
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toBe(idleReason.canRun === false ? idleReason.reason : "");
  });
});

describe("stopAvailability", () => {
  it("allows a stop only once the card has a thread of its own", () => {
    // Stopping a card that never started would reach the bot's unrelated
    // work, so the button stays off until there is a thread to name.
    expect(stopAvailability(owned("Alpha"))).toBe(false);
    expect(stopAvailability(owned("Alpha", { threadId: "thread-1" }))).toBe(true);
  });
});

describe("placeIn", () => {
  const a = card({ order: 0 });
  const b = card({ order: 4 });
  const c = card({ order: 8 });

  it("places a card arriving from another column before its target", () => {
    // A card that just crossed columns is not in the target column, so
    // dropPatch cannot find it — this is the case it exists for.
    expect(placeIn([a, b, c], b.id)).toBe(2);
  });

  it("places an arriving card last when dropped past the end", () => {
    expect(placeIn([a, b, c], null)).toBe(9);
  });

  it("places an arriving card first in an empty column", () => {
    expect(placeIn([], null)).toBe(0);
  });

  it("falls back to the end when the drop point vanished mid-drag", () => {
    expect(placeIn([a, b, c], "gone")).toBe(9);
  });
});

describe("cardStatusLabel", () => {
  it("says a card needs attention when it carries a failure", () => {
    // A card that stopped and said why is the most informative thing the
    // board can show, so it outranks the column it happens to sit in.
    const failed = owned("Alpha", { lastError: "boom", status: "in_progress" });
    expect(cardStatusLabel(failed)).toBe(cardStatusLabel(card({ lastError: "boom" })));
    expect(cardStatusLabel(failed)).not.toBe(cardStatusLabel(card({ status: "in_progress" })));
  });

  it("says a card is working while its bot is busy", () => {
    // The bot is genuinely mid-turn: the card says so rather than showing a
    // column that is already out of date.
    const working = owned("Alpha", { status: "todo", agent: { id: "bot-1", name: "W", busy: true } });
    expect(cardStatusLabel(working)).not.toBe(cardStatusLabel(owned("Alpha", { status: "todo" })));
  });

  it("says a card is waiting when its bot asked something", () => {
    // Only the server can see the transcript, so `waiting` arrives as a fact
    // rather than being guessed from `busy` — and it must read differently
    // from both a plain card and a working one.
    const waiting = owned("Alpha", { waiting: true, status: "in_progress" });
    expect(cardStatusLabel(waiting)).not.toBe(cardStatusLabel(owned("Alpha", { status: "in_progress" })));
    expect(cardStatusLabel(waiting)).not.toBe(
      cardStatusLabel(owned("Alpha", { status: "in_progress", agent: { id: "bot-1", name: "W", busy: true } })),
    );
  });

  it("lets a failure outrank a question", () => {
    // A card that stopped and said why tells the person more than one that
    // is merely waiting, so the failure keeps the card's headline.
    const both = owned("Alpha", { lastError: "boom", waiting: true });
    expect(cardStatusLabel(both)).toBe(cardStatusLabel(card({ lastError: "boom" })));
  });

  it("reads each column honestly", () => {
    const labels = WORK_COLUMNS.map((status) => cardStatusLabel(card({ status })));
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(WORK_COLUMNS.length);
  });
});

describe("statusTone", () => {
  it("paints a failure as danger regardless of its column", () => {
    expect(statusTone(card({ status: "done", lastError: "boom" }))).toBe("danger");
    expect(statusTone(card({ status: "blocked" }))).toBe("danger");
  });

  it("paints finished work as success and abandoned work as idle", () => {
    expect(statusTone(card({ status: "done" }))).toBe("success");
    expect(statusTone(card({ status: "cancelled" }))).toBe("idle");
  });

  it("paints a question as a warning rather than as work in flight", () => {
    // The work has stopped until it is answered, so a card that merely looked
    // busy would hide the thing the bot is asking for.
    expect(statusTone(card({ waiting: true }))).toBe("warning");
    expect(statusTone(card({ waiting: true, agent: { id: "b", name: "W", busy: true } }))).toBe("warning");
  });
});

describe("cardMark", () => {
  it("marks a card whose bot is waiting on a person", () => {
    expect(cardMark(card({ waiting: true }))).toBe("question");
  });

  it("marks a card whose bot is mid-turn", () => {
    expect(cardMark(card({ agent: { id: "b", name: "W", busy: true } }))).toBe("working");
  });

  it("marks a card that carries a failure, and only that, as an error", () => {
    // The red frame means one thing on this board. A blocked card is a status
    // the column already names, so it must not borrow the error mark.
    expect(cardMark(card({ lastError: "boom" }))).toBe("error");
    expect(cardMark(card({ status: "blocked" }))).toBe("none");
  });

  it("gives an ordinary card no mark at all", () => {
    expect(cardMark(card({ status: "todo" }))).toBe("none");
    expect(cardMark(card({ status: "done" }))).toBe("none");
  });

  it("lets an error outrank a question and a question outrank work", () => {
    const busy = { id: "b", name: "W", busy: true } as const;
    expect(cardMark(card({ lastError: "boom", waiting: true, agent: busy }))).toBe("error");
    expect(cardMark(card({ waiting: true, agent: busy }))).toBe("question");
  });
});

describe("elapsedLabel", () => {
  const format = (ms: number) => `${Math.round(ms / 1_000)}s`;

  it("counts from the start while the work is running", () => {
    const running = owned("Alpha", { status: "in_progress", startedAt: 1_000, finishedAt: undefined });
    expect(elapsedLabel(running, 6_000, format)).toBe("5s");
  });

  it("stops counting once the run has finished", () => {
    // This is the bug the fix is for: the clock used to keep ticking after
    // the bot stopped, because a settled card still carried `startedAt`.
    const settled = owned("Alpha", { status: "blocked", startedAt: 1_000, finishedAt: 4_000 });
    expect(elapsedLabel(settled, 60_000, format)).toBe("3s");
    expect(elapsedLabel(settled, 600_000, format)).toBe("3s");
  });

  it("shows nothing for a card that never ran", () => {
    // It used to fall back to "time since the card last changed" and format
    // that as if it were elapsed work, which read as a duration that meant
    // nothing. No run means no time.
    expect(elapsedLabel(card({ status: "todo", updatedAt: 4_000 }), 6_000, format)).toBeNull();
    expect(elapsedLabel(card({ status: "done", updatedAt: 1_000 }), 6_000, format)).toBeNull();
  });

  it("never reports a negative duration", () => {
    const running = owned("Alpha", { status: "in_progress", startedAt: 9_000, finishedAt: undefined });
    expect(elapsedLabel(running, 1_000, format)).toBe("0s");
  });
});

describe("runIsLive", () => {
  it("is true only while a run is going", () => {
    expect(runIsLive(owned("Alpha", { startedAt: 1_000, finishedAt: undefined }))).toBe(true);
    expect(runIsLive(owned("Alpha", { startedAt: 1_000, finishedAt: 4_000 }))).toBe(false);
    expect(runIsLive(card({ status: "todo" }))).toBe(false);
  });
});

// ── dates ──────────────────────────────────────────────────────────────────
//
// Two fields, two very different promises. `day` decides which board a card
// appears on, so its fallback has to be total: every card must land on a real
// day, or switching the filter on would silently hide work. `dueAt` is a
// deadline nothing acts on — if it ever started or moved a card, a date field
// would become a scheduler, and that is the one thing it must not be.
describe("the day a card belongs to", () => {
  /** Local midnight, which is what both the server and these helpers store. */
  const midnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

  const today = midnight(2026, 9, 14);
  const tomorrow = midnight(2026, 9, 15);
  const noonToday = today + 12 * 3_600_000;

  it("uses the card's own day when it has one", () => {
    expect(cardDay(card({ day: tomorrow, createdAt: today }))).toBe(tomorrow);
  });

  it("falls back to the creation day, so no card is ever undated", () => {
    // This is what makes the filter safe to switch on for a board that already
    // has cards: every existing one lands on the day it was made.
    expect(cardDay(card({ createdAt: noonToday }))).toBe(today);
    // A card made at 00:30 belongs to the day the person was living in.
    expect(cardDay(card({ createdAt: today + 30 * 60_000 }))).toBe(today);
  });

  it("compares whole days, not timestamps", () => {
    // Two cards made for the same date at different hours are the same day.
    expect(cardDay(card({ day: noonToday }))).toBe(cardDay(card({ day: today })));
  });

  it("keeps only the filtered day's cards, and everything when no day is chosen", () => {
    const cards = [
      card({ title: "A", day: today }),
      card({ title: "B", day: tomorrow }),
      card({ title: "C", createdAt: noonToday }),
    ];
    expect(filterByDay(cards, today).map((c) => c.title)).toEqual(["A", "C"]);
    expect(filterByDay(cards, tomorrow).map((c) => c.title)).toEqual(["B"]);
    expect(filterByDay(cards, null)).toHaveLength(3);
  });

  it("counts each day for the picker", () => {
    const counts = cardsByDay([
      card({ day: today }),
      card({ day: today }),
      card({ createdAt: noonToday }),
      card({ day: tomorrow }),
    ]);
    expect(counts.get(today)).toBe(3);
    expect(counts.get(tomorrow)).toBe(1);
  });

  it("always offers the three days a person works across", () => {
    // Fixed rather than derived from the cards: a board whose cards are all
    // for next week still gets a way back to today and yesterday.
    const { yesterday, today: t0, tomorrow } = relativeDays(noonToday);
    expect(t0).toBe(today);
    expect(yesterday).toBe(midnight(2026, 9, 13));
    expect(tomorrow).toBe(midnight(2026, 9, 15));
  });

  it("knows which day is today", () => {
    expect(isToday(card({ day: noonToday }), noonToday)).toBe(true);
    expect(isToday(card({ day: tomorrow }), noonToday)).toBe(false);
  });

  it("knows which days have already happened", () => {
    // A past day is read-only: the work on it is a record of what happened.
    expect(isPastDay(midnight(2026, 9, 13), noonToday)).toBe(true);
    // Today is not past, however little of it is left.
    expect(isPastDay(noonToday, noonToday)).toBe(false);
    expect(isPastDay(midnight(2026, 9, 15), noonToday)).toBe(false);
  });

  it("names the three days a person thinks in, and dates the rest", () => {
    // A stand-in for t() that returns the key, so the test pins WHICH label is
    // chosen without depending on the active language's wording.
    const translate = ((key: string) => key) as unknown as Parameters<typeof dayLabel>[2];
    const at = (day: number) => dayLabel(day, noonToday, translate);
    expect(at(today)).toBe("taskBoard.day.today");
    expect(at(tomorrow)).toBe("taskBoard.day.tomorrow");
    expect(at(midnight(2026, 9, 13))).toBe("taskBoard.day.yesterday");
    // Further out a relative word stops helping, so it is an actual date.
    expect(at(midnight(2026, 9, 20))).toMatch(/Sep|09/);
  });
});

describe("a due time", () => {
  const now = new Date(2026, 8, 14, 12, 0, 0).getTime();
  const later = now + 3_600_000;
  const earlier = now - 3_600_000;

  it("is late only once it has passed on work that is not finished", () => {
    expect(isOverdue(card({ dueAt: earlier, status: "todo" }), now)).toBe(true);
    expect(isOverdue(card({ dueAt: later, status: "todo" }), now)).toBe(false);
  });

  it("does not call finished work late", () => {
    // A deadline is about work still owed; a done card cannot be behind.
    expect(isOverdue(card({ dueAt: earlier, status: "done" }), now)).toBe(false);
    expect(isOverdue(card({ dueAt: earlier, status: "cancelled" }), now)).toBe(false);
  });

  it("says nothing about a card with no deadline", () => {
    expect(isOverdue(card({ status: "todo" }), now)).toBe(false);
  });
});