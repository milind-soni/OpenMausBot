// Run and stop on a card are WRAPPERS. The board must not grow a second way
// to run a turn — if it did, a card could start an agent through a path the
// chat does not use, and the two would drift. These tests pin the three
// properties that matter at that seam:
//
//   1. Starting a card opens a thread ONCE and then keeps it, so a card's
//      history lives in one conversation.
//   2. A start that cannot proceed reports itself on the CARD. A button that
//      fails silently — or only in a transcript nobody opened — is the single
//      most likely source of "it's just broken" reports here.
//   3. Stopping names the card's own thread. Without that, a stop reaches
//      whatever the bot happens to be showing, which may be somebody else's
//      work entirely.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("starting and stopping a card", () => {
  let session: VerificationServer;

  /** Launch the fixture with its engine held mid-turn, so "the thread is
   * already working" is a real state rather than a race this test would have
   * to win. The fixture is the only engine the server can reach here. */
  const launchHanging = () => launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };

  const createBot = async (name: string) => {
    const created = await api("POST", "/api/bots", { name });
    expect(created.status).toBe(201);
    return created.body.bot;
  };

  const createCard = async (input: Record<string, unknown>) => {
    const created = await api("POST", "/api/task-board/items", input);
    expect(created.status).toBe(201);
    return created.body.item;
  };

  const card = async (id: string) =>
    ((await api("GET", "/api/task-board")).body.items as any[]).find((item) => item.id === id);

  beforeEach(async () => {
    session = await launchVerificationServer();
  }, 30_000);

  afterEach(async () => {
    if (!session) return;
    await session.close();
  });

  it("refuses to start a card that nobody owns", async () => {
    const unowned = await createCard({ title: "Nobody's job" });

    const started = await api("POST", `/api/task-board/items/${unowned.id}/run`);
    expect(started.status).toBe(400);
    expect(started.body.error).toMatch(/assign this card/i);

    // The refusal is not a failure of the work: an unassigned card is simply
    // not startable, so it must not end up marked blocked.
    expect((await card(unowned.id)).status).not.toBe("blocked");
    expect((await card(unowned.id)).threadId).toBeUndefined();
  });

  it("refuses a card whose bot has since been deleted, without blocking it", async () => {
    const bot = await createBot("Short-lived");
    const orphan = await createCard({ title: "Orphaned work", ownerBotId: bot.id });
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBeLessThan(400);

    const started = await api("POST", `/api/task-board/items/${orphan.id}/run`);
    expect(started.status).toBe(400);
    expect((await card(orphan.id)).threadId).toBeUndefined();
  });

  it("answers 404 when asked to start or stop a card that does not exist", async () => {
    expect((await api("POST", "/api/task-board/items/no-such-card/run")).status).toBe(404);
    expect((await api("POST", "/api/task-board/items/no-such-card/stop")).status).toBe(404);
  });

  it("opens exactly one thread for a card and keeps it across starts", async () => {
    const bot = await createBot("Worker");
    const job = await createCard({ title: "Nightly reconcile", ownerBotId: bot.id });

    const first = await api("POST", `/api/task-board/items/${job.id}/run`);
    expect(first.status).toBe(200);
    expect(typeof first.body.threadId).toBe("string");

    const afterFirst = await card(job.id);
    expect(afterFirst.threadId).toBe(first.body.threadId);
    expect(afterFirst.status).toBe("in_progress");
    // The very fact that a start was dispatched is what startedAt records.
    expect(typeof afterFirst.startedAt).toBe("number");

    // A second start must not mint a second thread: the card's history belongs
    // in one conversation, and "open the chat" must always land on it. It is
    // refused as busy, and the refusal must leave the original thread intact.
    const second = await api("POST", `/api/task-board/items/${job.id}/run`);
    expect(second.status).toBe(409);
    expect((await card(job.id)).threadId).toBe(first.body.threadId);
  });

  it("says the thread is already working instead of starting a second turn", async () => {
    await session.close();
    session = await launchHanging();

    const bot = await createBot("Busy worker");
    const job = await createCard({ title: "Already running", ownerBotId: bot.id });

    const started = await api("POST", `/api/task-board/items/${job.id}/run`);
    expect(started.status).toBe(200);

    // With the engine held mid-turn, the second press is refused by the same
    // guard the composer hits, and the text says which thread to stop first.
    const again = await api("POST", `/api/task-board/items/${job.id}/run`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("thread_busy");
    expect(again.body.error).toMatch(/already working/i);

    // The person who pressed the button is looking at the board, so the card
    // is where the refusal has to land — and it must keep pointing at the
    // work that is genuinely still running.
    const reported = await card(job.id);
    expect(reported.status).toBe("blocked");
    expect(reported.lastError).toMatch(/already working/i);
    expect(reported.threadId).toBe(started.body.threadId);

    // Stopping is the documented way out of that state, and it must land on
    // the card's own thread.
    expect((await api("POST", `/api/task-board/items/${job.id}/stop`)).status).toBe(200);
  });

  it("refuses to stop a card that was never started", async () => {
    const bot = await createBot("Idle worker");
    const job = await createCard({ title: "Not yet running", ownerBotId: bot.id });

    const stopped = await api("POST", `/api/task-board/items/${job.id}/stop`);
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toMatch(/not been started/i);
  });

  it("stops the card's own thread and leaves the bot's active one alone", async () => {
    const bot = await createBot("Two jobs");
    const cardJob = await createCard({ title: "Board work", ownerBotId: bot.id });

    const started = await api("POST", `/api/task-board/items/${cardJob.id}/run`);
    expect(started.status).toBe(200);

    const stopped = await api("POST", `/api/task-board/items/${cardJob.id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.ok).toBe(true);

    // The card keeps its thread after a stop: stopping is not forgetting.
    expect((await card(cardJob.id)).threadId).toBe(started.body.threadId);
  });

  it("clears the blocked column once the card can run again", async () => {
    // The default fixture answers and settles, so a stop here really does
    // free the thread. (Under `hang` the engine never yields, and the stop
    // would be waiting on a process that has no reason to end — a fixture
    // property, not something the board controls.)
    const bot = await createBot("Recoverer");
    const job = await createCard({ title: "Blocked then fixed", ownerBotId: bot.id });

    const started = await api("POST", `/api/task-board/items/${job.id}/run`);
    expect(started.status).toBe(200);

    // Put the card in the state a real failure leaves behind, so the recovery
    // is exercised without depending on how a fixture fails.
    expect((await api("POST", `/api/task-board/items/${job.id}/stop`)).status).toBe(200);
    expect((await api("PATCH", `/api/task-board/items/${job.id}`, { status: "blocked" })).status).toBe(200);
    expect((await card(job.id)).status).toBe("blocked");

    // Running it again is what a person would try next, and it has to clear
    // the block rather than leave the card stuck where the failure put it.
    const restarted = await api("POST", `/api/task-board/items/${job.id}/run`);
    expect(restarted.status).toBe(200);

    const recovered = await card(job.id);
    expect(recovered.status).toBe("in_progress");
    expect(recovered.lastError).toBeUndefined();
    // One card, one thread, no matter how many times it was started.
    expect(recovered.threadId).toBe(started.body.threadId);
  });
});