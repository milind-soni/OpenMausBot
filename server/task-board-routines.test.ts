// A routine is a schedule; a board card is a place work can be seen. The link
// between them is ONE-WAY and it is the only thing these tests pin: a firing
// routine shows up on the board as the card FOR THAT ROUTINE, and the board
// never reaches back to create, edit or cancel a routine.
//
// The property that matters most here is volume. A job that fires every night
// must not stack a card per night, so the projection has to update one card in
// place — this is driven through the real scheduler and the real HTTP routes,
// because "how many cards did a second firing leave behind" is exactly the
// question a unit test with a stubbed clock would answer wrongly.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("routine runs on the task board", () => {
  let session: VerificationServer;

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

  const createRoutine = async (botId: string, name: string) => {
    const created = await api("POST", "/api/routines", {
      name,
      prompt: "Do the scheduled thing",
      target: "bot",
      botId,
      runOn: "maus",
      schedule: { type: "once", at: Date.now() + 3_600_000 },
      durationMinutes: 30,
    });
    expect(created.status).toBe(201);
    return created.body.routine;
  };

  /** Cards on the board that belong to one routine. */
  const cardsFor = async (routineId: string) =>
    ((await api("GET", "/api/task-board")).body.items as any[]).filter(
      (item) => item.routineId === routineId,
    );

  beforeEach(async () => {
    session = await launchVerificationServer();
  }, 30_000);

  afterEach(async () => {
    if (!session) return;
    await session.close();
  });

  it("puts a card on the board when a routine runs", async () => {
    const bot = await createBot("Scheduled worker");
    const routine = await createRoutine(bot.id, "Nightly reconcile");

    const started = await api("POST", `/api/routines/${routine.id}/run`);
    expect(started.status).toBe(201);

    await expect.poll(async () => (await cardsFor(routine.id)).length, { timeout: 15_000 }).toBe(1);

    const [card] = await cardsFor(routine.id);
    expect(card.title).toBe("Nightly reconcile");
    // The badge and the filter read the same field, so a routine card must be
    // marked as one for the board to draw its icon.
    expect(card.origin).toBe("routine");
    expect(card.ownerBotId).toBe(bot.id);
    // The card points at the thread the run actually works in, which is what
    // "open the chat" needs and what makes the board a record of the work.
    expect(typeof card.threadId).toBe("string");
    expect(["todo", "in_progress"]).toContain(card.status);
  });

  it("keeps one card per routine across repeated firings", async () => {
    const bot = await createBot("Twice scheduled");
    const routine = await createRoutine(bot.id, "Hourly ping");

    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await expect.poll(async () => (await cardsFor(routine.id)).length, { timeout: 15_000 }).toBe(1);

    // A second firing is the whole point of a schedule. It must land on the
    // same card: one card per routine, never one per run.
    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await expect.poll(async () => {
      const [card] = await cardsFor(routine.id);
      return Boolean(card);
    }, { timeout: 15_000 }).toBe(true);

    expect(await cardsFor(routine.id)).toHaveLength(1);
  });

  it("leaves the board untouched for a routine whose bot is hidden", async () => {
    const bot = await createBot("Hidden scheduler");
    const routine = await createRoutine(bot.id, "Hidden work");
    expect((await api("PATCH", `/api/bots/${bot.id}`, { hidden: true })).status).toBe(200);

    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    // Give the run a moment to settle before concluding nothing appeared.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // A card for a bot nobody can see is work nobody can act on, and the
    // filter would file it under General while its badge said something else.
    expect(await cardsFor(routine.id)).toHaveLength(0);
  });

  it("offers no way for the board to create a routine", async () => {
    // A board column is not a schedule. Creating a routine is the automations
    // screen's job, and the board must not grow a second way to do it — the
    // card route would then be able to schedule work nobody asked to repeat.
    const created = await api("POST", "/api/task-board/items", { title: "Board card" });
    expect(created.status).toBe(201);

    const card = created.body.item;
    expect(card.routineId).toBeUndefined();
    expect(card.origin).toBe("manual");

    // And the routine list did not grow a routine out of it.
    const calendar = await api("GET", "/api/routines");
    expect(calendar.body.routines.some((entry: any) => entry.name === "Board card")).toBe(false);
  });
});