import { describe, expect, it } from "vitest";

import type { RosterMember } from "../peer-roster.ts";
import { createRefusedHandoffs } from "./refused-handoffs.ts";
import type { Delivery } from "./person-inbox.ts";

const B = { people: ["mara@acme.test"] };
const rooms: RosterMember = { id: "rooms", name: "Rooms", visibility: B };
const hours: RosterMember = { id: "hours", name: "Staff Hours", visibility: B };
const books: RosterMember = { id: "books", name: "Bookkeeping", visibility: "admins" };
const listed: RosterMember = { ...rooms, id: "listed", name: "Listed", peers: ["hours"] };
const mausbot: RosterMember = { id: "maus", name: "MausBot", visibility: { people: ["olive@acme.test"] }, defaultBot: { person: "olive@acme.test" } };
const bots = [rooms, hours, books, listed, mausbot];

function fixture(over: { writer?: string; asked?: string | null; run?: boolean; own?: boolean } = {}) {
  const lines: Array<{ to: string; delivery: Delivery }> = [];
  const refused = createRefusedHandoffs({
    bots: () => bots, runOf: () => (over.run === false ? undefined : { routineId: "r1", botId: "rooms" }), writerOf: () => over.writer,
    askedPerson: () => over.asked ?? null, theirOwn: () => over.own === true, inbox: () => ({ deliver: (to, delivery) => { lines.push({ to, delivery }); } }), language: () => undefined,
  });
  return { refused, lines };
}

describe("a routine's refused hand-off", () => {
  it("makes the run say so, once, whether the bot was named by id or by name", () => {
    for (const named of ["books", "Bookkeeping", "@bookkeeping"]) {
      const { refused } = fixture();
      refused.settled("t", rooms, [named], 403);
      expect(refused.take("t")).toBe("Rooms couldn't hand this to Bookkeeping, because they're shared with different people. Nothing was sent.");
      expect(refused.take("t")).toBeNull();
    }
  });

  it("says why when the bot's own list of peers is what refused it", () => {
    const { refused } = fixture();
    refused.settled("t", listed, ["Rooms"], 403);
    expect(refused.take("t")).toBe("Listed couldn't hand this to Rooms, because it isn't set to talk to it. Nothing was sent.");
  });

  it("stays quiet about anything that wasn't the refusal: a hand-off that went through, a typo, the bot itself, someone's own MausBot", () => {
    for (const [named, status] of [["Staff Hours", 202], ["Staff Hours", 403], ["Bookkeeper", 403], ["Rooms", 403], ["MausBot", 403], ["books", 202]] as const) {
      const { refused } = fixture();
      refused.settled("t", rooms, [named], status);
      expect(refused.take("t"), named).toBeNull();
    }
  });

  it("forgets a refusal once the same bot was reached after all", () => {
    const { refused } = fixture();
    refused.settled("t", rooms, ["Bookkeeping"], 403);
    refused.settled("t", rooms, ["books"], 202);
    expect(refused.take("t")).toBeNull();
  });

  it("keeps nothing for a conversation that isn't a routine's run", () => {
    const { refused } = fixture({ run: false });
    refused.settled("t", rooms, ["Bookkeeping"], 403);
    expect(refused.take("t")).toBeNull();
  });

  it("tells who wrote the routine in their inbox when the bot's failures reach someone else, once for the same words", () => {
    const { refused, lines } = fixture({ writer: "p_olive", asked: "p_mara" });
    refused.settled("t", rooms, ["Bookkeeping"], 403);
    refused.take("t");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.to).toBe("p_olive");
    expect(lines[0]!.delivery).toMatchObject({ kind: "notice", quiet: false, title: "Rooms's routine couldn't hand off its work", text: "Rooms couldn't hand this to Bookkeeping, because they're shared with different people. Nothing was sent." });
    refused.settled("t2", rooms, ["Bookkeeping"], 403);
    refused.take("t2");
    expect(lines, "the next day's run says the same").toHaveLength(1);
  });

  it("reaches a person's inbox from a run of their own too, where the failure's own notification already tells them", () => {
    const { refused, lines } = fixture({ writer: "p_mara", asked: "p_mara", own: true });
    refused.settled("t", rooms, ["Bookkeeping"], 403);
    refused.take("t");
    expect(lines.map((line) => [line.to, line.delivery.quiet])).toEqual([["p_mara", true]]);
  });

  it("sends no second line when the bot's failures already reach who wrote it", () => {
    const { refused, lines } = fixture({ writer: "p_olive", asked: "p_olive" });
    refused.settled("t", rooms, ["Bookkeeping"], 403);
    refused.take("t");
    expect(lines).toEqual([]);
  });
});
