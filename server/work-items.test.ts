// The board's load-bearing property is that a card is a durable record of
// work, not a view of a running turn. So the tests below pin two things above
// all: what a person sets survives a restart, and a card can never become a
// second implementation of "run a bot" — the store only ever REMEMBERS what
// the route did.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BOARD_ID, MAX_WORK_ITEMS, WorkItems, isWorkStatus } from "./work-items.ts";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-work-items-"));
  dirs.push(dir);
  return join(dir, "work-items.json");
}

/** A manager on a fresh disposable file, plus that file's path so a test can
 * reopen it and prove what was actually written. */
function board(now = 1_700_000_000_000) {
  const file = tempFile();
  return { file, open: () => new WorkItems({ file, now: () => now }) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WorkItems", () => {
  it("creates a card in the backlog of the default board", () => {
    const items = board().open();
    const card = items.create({ title: "Fix invoice export" });

    expect(card).toMatchObject({
      boardId: DEFAULT_BOARD_ID,
      title: "Fix invoice export",
      status: "backlog",
      artifacts: [],
    });
    expect(card.id).toBeTruthy();
    expect(items.list()).toHaveLength(1);
  });

  it("refuses a card with no title — a blank card is not work", () => {
    const items = board().open();
    expect(() => items.create({ title: "   " })).toThrow(/needs a title/);
    expect(items.list()).toEqual([]);
  });

  it("puts a new card at the top of its column, not below everything finished", () => {
    const items = board().open();
    const first = items.create({ title: "one", status: "todo" });
    const second = items.create({ title: "two", status: "todo" });

    expect(second.order).toBeLessThan(first.order);
    const column = items.list({ status: ["todo"] }).sort((a, b) => a.order - b.order);
    expect(column.map((card) => card.title)).toEqual(["two", "one"]);
  });

  it("survives a restart: what a person set is on disk and comes back", () => {
    const { file, open } = board();
    const items = open();
    const card = items.create({ title: "Deploy the edge", brief: "after the review", status: "todo" });
    items.update(card.id, { status: "in_progress", order: 4.5 });

    const reopened = new WorkItems({ file });
    const restored = reopened.get(card.id)!;
    expect(restored).toMatchObject({
      title: "Deploy the edge",
      brief: "after the review",
      status: "in_progress",
      order: 4.5,
    });
  });

  it("tolerates a missing or corrupt file instead of refusing to boot", () => {
    const file = tempFile();
    // no file at all
    expect(new WorkItems({ file }).list()).toEqual([]);

    writeFileSync(file, "{not json");
    expect(new WorkItems({ file }).list()).toEqual([]);

    // a well-formed file with junk rows keeps only the rows that are cards
    writeFileSync(file, JSON.stringify({ version: 1, items: [null, 7, { id: "x" }, { id: "y", title: "ok", status: "nope" }] }));
    expect(new WorkItems({ file }).list()).toEqual([]);
  });

  it("drops a row whose status is not a column rather than rendering it nowhere", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({
      version: 1,
      items: [
        { id: "a", title: "good", status: "todo", createdAt: 1, updatedAt: 1, order: 0 },
        { id: "b", title: "bad", status: "archived", createdAt: 1, updatedAt: 1, order: 0 },
      ],
    }));
    expect(new WorkItems({ file }).list().map((card) => card.title)).toEqual(["good"]);
  });

  it("writes the board with owner-only permissions", () => {
    const { file, open } = board();
    open().create({ title: "secret-ish" });
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  it("scrubs a credential pasted into a brief before it is stored", () => {
    const { file, open } = board();
    const card = open().create({
      title: "rotate the key",
      brief: "run it with OPENAI_API_KEY=sk-live-abcdefghijklmnop and then check",
    });
    expect(card.brief).not.toContain("sk-live-abcdefghijklmnop");
    // Stored, not merely displayed: the file on disk must be clean too.
    expect(readFileSync(file, "utf8")).not.toContain("sk-live-abcdefghijklmnop");
  });

  it("keeps a bot's own error text off the disk in the clear", () => {
    const items = board().open();
    const card = items.create({ title: "ship" });
    const failed = items.fail(card.id, "curl -H 'Authorization: Bearer abcdefghijklmnop' failed");
    expect(failed.status).toBe("blocked");
    expect(failed.lastError).not.toContain("abcdefghijklmnop");
  });

  it("hands a card's thread back, so a chat opened elsewhere can find the card", () => {
    const items = board().open();
    const card = items.create({ title: "index the vault", ownerBotId: "bot-1" });
    items.attachThread(card.id, "thread-9");

    expect(items.byThread("thread-9")!.id).toBe(card.id);
    expect(items.byThread("thread-other")).toBeUndefined();
  });

  it("starting a card moves it into progress and remembers the thread", () => {
    const items = board().open();
    const card = items.create({ title: "run the migration", status: "todo", ownerBotId: "bot-1" });
    const started = items.attachThread(card.id, "thread-1");

    expect(started.status).toBe("in_progress");
    expect(started.threadId).toBe("thread-1");
    expect(started.startedAt).toBeTypeOf("number");
  });

  it("never drags a card out of a terminal column just because a thread appeared", () => {
    const items = board().open();
    const card = items.create({ title: "done already", status: "done" });
    expect(items.attachThread(card.id, "thread-2").status).toBe("done");
  });

  it("clears a failure's mark when the card is started again", () => {
    const items = board().open();
    const card = items.create({ title: "retry me", ownerBotId: "bot-1" });
    items.fail(card.id, "the agent died");
    const restarted = items.attachThread(card.id, "thread-3");

    expect(restarted.lastError).toBeUndefined();
    expect(restarted.status).toBe("in_progress");
  });

  it("stops the clock when the card's turn ends, without claiming the work is done", () => {
    const items = board().open();
    const card = items.create({ title: "finish the report", status: "todo", ownerBotId: "bot-1" });
    expect(items.attachThread(card.id, "thread-1").startedAt).toBeTypeOf("number");

    const settled = items.settle(card.id, { ok: true })!;
    // Only a person knows whether the job is finished, so a settled turn
    // leaves the card where they can still move it to Done themselves.
    expect(settled.status).toBe("in_progress");
    expect(settled.startedAt).toBeUndefined();
    expect(settled.lastError).toBeUndefined();
  });

  it("blocks a card whose bot failed mid-turn instead of leaving it working", () => {
    const items = board().open();
    const card = items.create({ title: "will explode", status: "todo", ownerBotId: "bot-1" });
    items.attachThread(card.id, "thread-1");

    // The dispatch succeeded and the turn then failed, which the run route
    // cannot see — this is the case that used to hang in In progress.
    const settled = items.settle(card.id, { ok: false, reason: "the provider refused the turn" })!;
    expect(settled.status).toBe("blocked");
    expect(settled.lastError).toBe("the provider refused the turn");
    expect(settled.startedAt).toBeUndefined();
  });

  it("says something useful when a failed turn gives no reason", () => {
    const items = board().open();
    const card = items.create({ title: "quiet failure", status: "in_progress", ownerBotId: "bot-1" });
    items.attachThread(card.id, "thread-1");

    const settled = items.settle(card.id, { ok: false, reason: null })!;
    expect(settled.status).toBe("blocked");
    expect(settled.lastError).toBeTruthy();
  });

  it("leaves a card a person moved alone when its late turn settles", () => {
    const items = board().open();
    const card = items.create({ title: "already done", status: "done", ownerBotId: "bot-1" });

    // A turn that finishes after the person tidied the board must not reopen
    // or re-block the card they already decided about.
    const settled = items.settle(card.id, { ok: false, reason: "too late" })!;
    expect(settled.status).toBe("done");
    expect(settled.lastError).toBeUndefined();
  });

  it("clears the old bot's failure when the card is given to another bot", () => {
    // The failure belonged to the bot being taken off the card. Keeping it
    // made a freshly assigned card read "Needs attention" — and wear the
    // alert face — for a bot that had never run it.
    const items = board().open();
    const card = items.create({ title: "hand it over", ownerBotId: "bot-1", status: "in_progress" });
    items.attachThread(card.id, "thread-1");
    items.settle(card.id, { ok: false, reason: "the provider refused the turn" });

    const moved = items.update(card.id, { ownerBotId: "bot-2" });
    expect(moved.ownerBotId).toBe("bot-2");
    expect(moved.lastError).toBeUndefined();
    // And off the blocked column, because it was blocked by the old bot.
    expect(moved.status).toBe("todo");
  });

  it("does not move a card a person already finished just because it changed hands", () => {
    const items = board().open();
    const card = items.create({ title: "done and handed over", ownerBotId: "bot-1", status: "done" });
    const moved = items.update(card.id, { ownerBotId: "bot-2" });
    expect(moved.status).toBe("done");
  });

  it("does nothing for a card that is not running", () => {
    const items = board().open();
    const card = items.create({ title: "still waiting", status: "todo" });
    expect(items.settle(card.id, { ok: false, reason: "nope" })!.status).toBe("todo");
    expect(items.settle("no-such-card", { ok: true })).toBeNull();
  });

  it("abandons the old thread when a card is given to a different bot", () => {
    const items = board().open();
    const card = items.create({ title: "move it", ownerBotId: "bot-1", status: "in_progress" });
    items.attachThread(card.id, "thread-of-bot-1");
    const moved = items.update(card.id, { ownerBotId: "bot-2" });

    // Keeping bot-1's thread would point "open the chat" at a conversation
    // bot-2 has never seen.
    expect(moved.ownerBotId).toBe("bot-2");
    expect(moved.threadId).toBeUndefined();
  });

  it("keeps a thread when the owner is set to the bot that already had it", () => {
    const items = board().open();
    const card = items.create({ title: "same owner", ownerBotId: "bot-1" });
    items.attachThread(card.id, "thread-keep");
    expect(items.update(card.id, { ownerBotId: "bot-1" }).threadId).toBe("thread-keep");
  });

  it("unassigns a card when the owner is cleared, and lets it be reassigned later", () => {
    const items = board().open();
    const card = items.create({ title: "unowned", ownerBotId: "bot-1" });
    const cleared = items.update(card.id, { ownerBotId: null });

    expect(cleared.ownerBotId).toBeUndefined();
    expect(items.list({ ownerBotId: "bot-1" })).toEqual([]);
  });

  it("rejects a status that is not a column", () => {
    const items = board().open();
    const card = items.create({ title: "typo" });
    expect(() => items.update(card.id, { status: "archived" as never })).toThrow(/unknown status/);
  });

  it("reports a missing card rather than creating one on a blind update", () => {
    const items = board().open();
    expect(() => items.update("nope", { title: "x" })).toThrow(/no such card/);
    expect(() => items.attachThread("nope", "t")).toThrow(/no such card/);
    expect(items.remove("nope")).toBe(false);
  });

  it("filters by column and by owner without a second index", () => {
    const items = board().open();
    items.create({ title: "a", status: "todo", ownerBotId: "bot-1" });
    items.create({ title: "b", status: "done", ownerBotId: "bot-1" });
    items.create({ title: "c", status: "todo", ownerBotId: "bot-2" });

    expect(items.list({ status: ["todo"] }).map((card) => card.title).sort()).toEqual(["a", "c"]);
    expect(items.list({ ownerBotId: "bot-1" }).map((card) => card.title).sort()).toEqual(["a", "b"]);
    expect(items.list({ ownerBotId: "bot-2", status: ["todo"] }).map((card) => card.title)).toEqual(["c"]);
  });

  it("keeps only the artifact shapes a card can render", () => {
    const items = board().open();
    const card = items.create({ title: "with files" });
    const saved = items.update(card.id, {
      artifacts: [
        { kind: "file", ref: "src/index.ts" },
        { kind: "url", ref: "https://example.com/run", label: "the run" },
        { kind: "nonsense", ref: "x" } as never,
        { kind: "file", ref: "   " },
      ],
    });
    expect(saved.artifacts).toEqual([
      { kind: "file", ref: "src/index.ts" },
      { kind: "url", ref: "https://example.com/run", label: "the run" },
    ]);
  });

  it("bounds the board by discarding the oldest finished cards, never open work", () => {
    let clock = 1_000;
    const file = tempFile();
    const items = new WorkItems({ file, now: () => (clock += 1) });
    const keep = items.create({ title: "still open", status: "todo" });
    for (let i = 0; i < MAX_WORK_ITEMS; i += 1) items.create({ title: `finished ${i}`, status: "done" });

    expect(items.list().length).toBeLessThanOrEqual(MAX_WORK_ITEMS);
    expect(items.get(keep.id)).toBeDefined();
  });

  it("accepts every column the board draws and nothing else", () => {
    expect(isWorkStatus("in_progress")).toBe(true);
    expect(isWorkStatus("backlog")).toBe(true);
    expect(isWorkStatus("in-progress")).toBe(false);
    expect(isWorkStatus(3)).toBe(false);
  });

  it("marks a card a routine produced, so the board can badge it", () => {
    const items = board().open();
    const manual = items.create({ title: "by hand" });
    const fromRoutine = items.create({ title: "nightly report", routineId: "routine-1", origin: "routine" });

    expect(manual.origin).toBe("manual");
    expect(manual.routineId).toBeUndefined();
    expect(fromRoutine.origin).toBe("routine");
    expect(fromRoutine.routineId).toBe("routine-1");
  });

  it("never badges a card as a routine's without a routine to point at", () => {
    const items = board().open();
    // An origin with no id would render an icon that opens nothing, so the
    // id decides and the flag is ignored.
    const card = items.create({ title: "odd", origin: "routine" });
    expect(card.origin).toBe("manual");
    expect(card.routineId).toBeUndefined();
  });

  it("keeps the badge honest after a restart, even if the origin field lies", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({
      version: 1,
      items: [
        // names a routine but claims to be manual
        { id: "a", title: "from a routine", status: "todo", routineId: "routine-9", origin: "manual", createdAt: 1, updatedAt: 1, order: 0 },
        // claims a routine but names none
        { id: "b", title: "claims one", status: "todo", origin: "routine", createdAt: 1, updatedAt: 1, order: 0 },
      ],
    }));
    const items = new WorkItems({ file });

    expect(items.get("a")).toMatchObject({ origin: "routine", routineId: "routine-9" });
    expect(items.get("b")!.origin).toBe("manual");
    expect(items.get("b")!.routineId).toBeUndefined();
  });

  it("hands back the newest card a routine produced, not the first ever", () => {
    let clock = 1_000;
    const items = new WorkItems({ file: tempFile(), now: () => (clock += 10) });
    items.create({ title: "run one", routineId: "routine-7", origin: "routine" });
    const latest = items.create({ title: "run two", routineId: "routine-7", origin: "routine" });
    items.create({ title: "another routine", routineId: "routine-8", origin: "routine" });

    expect(items.byRoutine("routine-7")!.id).toBe(latest.id);
    expect(items.byRoutine("routine-nope")).toBeUndefined();
  });

  it("leaves a routine card's routine alone when a person renames or moves it", () => {
    const items = board().open();
    const card = items.create({ title: "nightly", routineId: "routine-1", origin: "routine" });
    const moved = items.update(card.id, { title: "nightly report", status: "done", order: 3 });

    // The card is a projection of the schedule; editing the card must not
    // quietly detach it from the routine that produced it.
    expect(moved.routineId).toBe("routine-1");
    expect(moved.origin).toBe("routine");
  });

  it("keeps one card per routine, updating it instead of stacking a new one", () => {
    let clock = 1_000;
    const items = new WorkItems({ file: tempFile(), now: () => (clock += 10) });
    const first = items.projectRoutine({
      routineId: "routine-1",
      title: "Nightly report",
      ownerBotId: "bot-1",
      threadId: "thread-1",
      status: "in_progress",
    });
    items.projectRoutine({
      routineId: "routine-1",
      title: "Nightly report",
      ownerBotId: "bot-1",
      threadId: "thread-1",
      status: "done",
    });

    // A job that fires every night must not leave a trail of cards behind it:
    // the card shows what the schedule is doing, not everything it ever did.
    expect(items.list()).toHaveLength(1);
    const card = items.get(first.id)!;
    expect(card.status).toBe("done");
    expect(card.origin).toBe("routine");
    expect(card.routineId).toBe("routine-1");
  });

  it("does not drag a finished routine card back into the running columns", () => {
    let clock = 1_000;
    const items = new WorkItems({ file: tempFile(), now: () => (clock += 10) });
    const card = items.projectRoutine({ routineId: "routine-1", title: "nightly", status: "done" });

    // A person marked the work finished. The schedule firing again is not a
    // reason to reopen a decision someone already made.
    const after = items.projectRoutine({
      routineId: "routine-1",
      title: "nightly",
      status: "in_progress",
      threadId: "thread-2",
    });

    expect(items.list()).toHaveLength(1);
    expect(after.id).toBe(card.id);
    expect(after.status).toBe("done");
  });

  it("carries why a routine run failed onto its card", () => {
    const items = board().open();
    const card = items.projectRoutine({
      routineId: "routine-1",
      title: "nightly",
      status: "blocked",
      detail: "the assigned bot no longer exists",
    });

    // A failure that only ever appears in a transcript nobody opened reads as
    // a schedule that silently stopped working.
    expect(card.status).toBe("blocked");
    expect(card.lastError).toMatch(/no longer exists/);
  });

  it("refuses a routine card with no routine to point at", () => {
    const items = board().open();
    expect(() => items.projectRoutine({ routineId: "", title: "orphan", status: "todo" })).toThrow();
  });

  it("names a card whose routine has no name, and never erases a name it has", () => {
    const items = board().open();
    const card = items.projectRoutine({ routineId: "routine-1", title: "   ", status: "todo" });
    // A nameless routine still has work worth showing, so the card falls back
    // to the routine's id rather than throwing the projection away.
    expect(card.title).toBe("routine-1");

    const renamed = items.projectRoutine({ routineId: "routine-1", title: "", status: "in_progress" });
    // A blank name on a later run must not erase a name already on the board.
    expect(renamed.title).toBe("routine-1");
  });
});