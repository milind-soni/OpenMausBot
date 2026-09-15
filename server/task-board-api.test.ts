// The board's load-bearing property is that a card is a durable record of
// work, and the team filter is a partition, not a spotlight: every card
// belongs to exactly one team (the section of its owner, or the empty-key
// "General" team when it has no visible owner), so the same card must never
// be shown under two named teams at once.
//
// These tests drive the real HTTP routes through the isolated verification
// harness, with real bots created through POST /api/bots, because the team a
// card lands in is resolved from the OWNER bot's stored section — the wiring
// between the board and the store is exactly what is worth pinning here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("task board HTTP routes through the isolated control surface", () => {
  let session: VerificationServer;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };

  /** A bot created through the public API, with the section its card's team
   * is derived from. `POST /api/bots` accepts `section` directly, which is
   * the same field the sidebar groups by. */
  const createBot = async (name: string, section?: string) => {
    const created = await api("POST", "/api/bots", { name, ...(section !== undefined ? { section } : {}) });
    expect(created.status).toBe(201);
    return created.body.bot;
  };

  const createCard = async (input: Record<string, unknown>) => {
    const created = await api("POST", "/api/task-board/items", input);
    expect(created.status).toBe(201);
    return created.body.item;
  };

  const board = async (query = "") => (await api("GET", `/api/task-board${query}`)).body.items as any[];
  const titles = (items: any[]) => items.map((item) => item.title).sort();

  beforeEach(async () => {
    session = await launchVerificationServer();
  }, 30_000);

  afterEach(async () => {
    if (!session) return;
    await session.close();
  });

  it("creates a card and reads it back from the board", async () => {
    const card = await createCard({ title: "Reconcile the invoices", brief: "before the audit" });

    const listed = await board();
    expect(listed.find((item) => item.id === card.id)).toMatchObject({
      title: "Reconcile the invoices",
      brief: "before the audit",
      status: "backlog",
      agent: null,
    });
  });

  it("reports the owner's section, name and activity on a card that has one", async () => {
    const bot = await createBot("Alpha owner", "Alpha");
    const card = await createCard({ title: "Owned card", ownerBotId: bot.id, status: "todo" });

    const item = (await board()).find((candidate) => candidate.id === card.id)!;
    expect(item.agent).toMatchObject({
      id: bot.id,
      name: "Alpha owner",
      section: "Alpha",
      hidden: false,
    });
    expect(typeof item.agent.activity).toBe("string");
    expect(item.ownerBotId).toBe(bot.id);
  });

  it("shows each card in exactly one team, and only the unowned ones in General", async () => {
    const alphaOwner = await createBot("Alpha owner", "Alpha");
    const betaOwner = await createBot("Beta owner", "Beta");
    const unsectionedOwner = await createBot("Unfiled owner");

    await createCard({ title: "Alpha card", ownerBotId: alphaOwner.id });
    await createCard({ title: "Beta card", ownerBotId: betaOwner.id });
    await createCard({ title: "Unowned card" });
    await createCard({ title: "Unsectioned owner card", ownerBotId: unsectionedOwner.id });

    // A named team contains its owner's cards and nothing else.
    expect(titles(await board("?team=Alpha"))).toEqual(["Alpha card"]);
    expect(titles(await board("?team=Beta"))).toEqual(["Beta card"]);

    // The empty team key is the unsectioned team: unowned cards and cards
    // whose owner was never filed, together and never mixed into a name.
    expect(titles(await board("?team="))).toEqual(["Unowned card", "Unsectioned owner card"]);

    // Omitting the parameter is the whole board.
    expect(titles(await board())).toEqual([
      "Alpha card",
      "Beta card",
      "Unowned card",
      "Unsectioned owner card",
    ]);

    // The partition itself: each card belongs to exactly one team, so no
    // title appears in more than one named team's response.
    const namedTeams = ["Alpha", "Beta"];
    for (const card of await board()) {
      const inTeams = [];
      for (const team of namedTeams) {
        const ids = (await board(`?team=${encodeURIComponent(team)}`)).map((item) => item.id);
        if (ids.includes(card.id)) inTeams.push(team);
      }
      expect(inTeams.filter((team) => team !== (card.agent?.section ?? "")), card.title).toEqual([]);
      expect(inTeams.length).toBeLessThanOrEqual(1);
    }
  });

  it("drops a hidden bot's card out of its old named team", async () => {
    const owner = await createBot("Soon hidden", "Alpha");
    await createCard({ title: "Hidden owner card", ownerBotId: owner.id });
    expect(titles(await board("?team=Alpha"))).toEqual(["Hidden owner card"]);

    expect((await api("PATCH", `/api/bots/${owner.id}`, { hidden: true })).status).toBe(200);

    // A hidden owner has no team, so the card falls to General rather than
    // lingering under a team whose bot is no longer visible.
    expect(titles(await board("?team=Alpha"))).toEqual([]);
    expect(titles(await board("?team="))).toContain("Hidden owner card");
  });

  it("lists teams with their bot counts and always reaches General", async () => {
    await createBot("Alpha one", "Alpha");
    await createBot("Alpha two", "Alpha");
    await createBot("Beta one", "Beta");

    const teams = (await api("GET", "/api/task-board/teams")).body.teams as Array<{ key: string; name: string; count: number }>;
    const alpha = teams.find((team) => team.key === "Alpha")!;
    const beta = teams.find((team) => team.key === "Beta")!;
    const general = teams.find((team) => team.key === "")!;

    expect(alpha).toMatchObject({ name: "Alpha", count: 2 });
    expect(beta).toMatchObject({ name: "Beta", count: 1 });
    // The empty key is always offered, named "General", even when it is the
    // team a bot lands in by default.
    expect(general).toMatchObject({ key: "", name: "General" });
    expect(general.count).toBeGreaterThanOrEqual(1);
    // The empty key is the team nobody filed a bot into; it is always
    // offered first so the switcher has a stable entry point.
    expect(teams[0]).toMatchObject({ key: "", name: "General" });
  });

  it("rejects a malformed card instead of storing it", async () => {
    const bot = await createBot("Validation owner", "Alpha");

    expect((await api("POST", "/api/task-board/items", {})).status).toBe(400);
    expect((await api("POST", "/api/task-board/items", { title: "   " })).status).toBe(400);
    expect((await api("POST", "/api/task-board/items", { title: "ok", status: "shipping" })).status).toBe(400);
    expect((await api("POST", "/api/task-board/items", { title: "ok", ownerBotId: "no-such-bot" })).status).toBe(400);
    expect((await api("POST", "/api/task-board/items", { title: "ok", dueBy: "friday" })).status).toBe(400);

    // The rejected cards left no rows behind.
    expect((await board()).some((item) => item.ownerBotId === bot.id)).toBe(false);
  });

  it("answers 404 for card mutations that name no card", async () => {
    expect((await api("PATCH", "/api/task-board/items/no-such-card", { status: "todo" })).status).toBe(404);
    expect((await api("DELETE", "/api/task-board/items/no-such-card")).status).toBe(404);
  });

  // Dates are two fields with the same shape and different meanings: `day`
  // says which day's board the card belongs on, `dueAt` is a deadline nothing
  // acts on. Neither may be invented, and neither may be silently cleared by a
  // patch that never mentioned it — a drag between columns is a patch.
  describe("the two dates a card can carry", () => {
    /** Local midnight for an offset in days from today, which is what the
     * client sends and what `cardDay` compares against. */
    const localDay = (offsetDays: number) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + offsetDays);
      return date.getTime();
    };

    const reread = async (id: string) =>
      (await board()).find((item) => item.id === id)!;

    it("keeps the day and the deadline a card was created with", async () => {
      const day = localDay(2);
      const dueAt = localDay(3) + 17 * 3_600_000;
      const card = await createCard({ title: "Dated work", day, dueAt });

      expect(card).toMatchObject({ day, dueAt });
      expect(await reread(card.id)).toMatchObject({ day, dueAt });
    });

    it("sets and clears one date without touching the other", async () => {
      const day = localDay(1);
      const dueAt = localDay(2) + 9 * 3_600_000;
      const card = await createCard({ title: "Two dates", day, dueAt });

      // Clearing the deadline leaves the day alone…
      expect((await api("PATCH", `/api/task-board/items/${card.id}`, { dueAt: null })).status).toBe(200);
      expect(await reread(card.id)).toMatchObject({ day });
      expect((await reread(card.id)).dueAt).toBeUndefined();

      // …and moving the card between columns touches neither.
      const movedDay = localDay(4);
      await api("PATCH", `/api/task-board/items/${card.id}`, { day: movedDay, dueAt });
      await api("PATCH", `/api/task-board/items/${card.id}`, { status: "in_progress", order: 1 });
      expect(await reread(card.id)).toMatchObject({ day: movedDay, dueAt, status: "in_progress" });

      // …and clearing the day returns the card to its creation day.
      expect((await api("PATCH", `/api/task-board/items/${card.id}`, { day: null })).status).toBe(200);
      const cleared = await reread(card.id);
      expect(cleared.day).toBeUndefined();
      expect(cleared.dueAt).toBe(dueAt);
    });

    it("refuses a date that is not a usable timestamp, and keeps the old one", async () => {
      const day = localDay(1);
      const card = await createCard({ title: "Guarded dates", day });

      // A unit mix-up (seconds where ms are expected) is out of range, so it
      // is dropped rather than dating the card to 1970.
      for (const bad of [1_700_000_000, 0, -1]) {
        const patched = await api("PATCH", `/api/task-board/items/${card.id}`, { day: bad });
        expect(patched.status).toBe(200);
        expect((await reread(card.id)).day, `day=${bad}`).toBe(day);
      }
    });

    it("does not carry a date on a card that never had one", async () => {
      const card = await createCard({ title: "Undated work" });
      const item = await reread(card.id);
      expect(item.day).toBeUndefined();
      expect(item.dueAt).toBeUndefined();
    });
  });

  it("moves a card between columns without forgetting its routine link", async () => {
    const card = await createCard({ title: "Move me", status: "todo" });

    const moved = await api("PATCH", `/api/task-board/items/${card.id}`, { status: "in_progress" });
    expect(moved.status).toBe(200);
    expect(moved.body.item.status).toBe("in_progress");

    // A status-only patch is not a licence to drop fields it never mentioned.
    const reread = (await board()).find((item) => item.id === card.id)!;
    expect(reread.routineId).toBe(card.routineId);
    expect(reread.title).toBe("Move me");
    expect(reread.status).toBe("in_progress");
  });

  it("removes a deleted card from the board", async () => {
    const card = await createCard({ title: "Delete me" });
    expect((await board()).some((item) => item.id === card.id)).toBe(true);

    expect((await api("DELETE", `/api/task-board/items/${card.id}`)).status).toBe(200);
    expect((await board()).some((item) => item.id === card.id)).toBe(false);
  });
});