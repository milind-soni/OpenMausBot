import { describe, expect, it } from "vitest";

import type { RosterMember } from "../peer-roster.ts";
import type { RoutineRunStatus } from "../../shared/routines.ts";
import { createRefusedHandoffs } from "./refused-handoffs.ts";
import type { Delivery } from "./person-inbox.ts";

const B = { people: ["mara@acme.test"] };
const rooms: RosterMember = { id: "rooms", name: "Rooms", visibility: B };
const hours: RosterMember = { id: "hours", name: "Staff Hours", visibility: B };
const books: RosterMember = { id: "books", name: "Bookkeeping", visibility: "admins" };
const ledger: RosterMember = { id: "ledger", name: "Ledger", visibility: "admins" };
const mausbot: RosterMember = { id: "maus", name: "MausBot", visibility: { people: ["olive@acme.test"] }, defaultBot: { person: "olive@acme.test" } };
const bots = [rooms, hours, books, ledger, mausbot];

const SAID = "Rooms couldn't hand this to Bookkeeping, because they're shared with different people. Nothing was sent.";
const LEDGER_SAID = "Rooms couldn't hand this to Ledger, because they're shared with different people. Nothing was sent.";
const r1 = { id: "run_1", routineId: "r1", botId: "rooms" }, r2 = { id: "run_2", routineId: "r2", botId: "rooms" };

function fixture(over: { writer?: string; asked?: string | null; run?: boolean; own?: boolean; status?: (id: string) => RoutineRunStatus | undefined } = {}) {
  const lines: Array<{ to: string; delivery: Delivery }> = [];
  let current: typeof r1 | undefined = over.run === false ? undefined : r1;
  const refused = createRefusedHandoffs({
    bots: () => bots, runOf: () => current, statusOf: (id) => over.status?.(id) ?? "running", writerOf: () => over.writer,
    askedPerson: () => over.asked ?? null, theirOwn: () => over.own === true, inbox: () => ({ deliver: (to, delivery) => { lines.push({ to, delivery }); } }), language: () => undefined,
  });
  return { refused, lines, now: (run: typeof r1 | undefined) => { current = run; } };
}

describe("a routine's refused hand-off", () => {
  it("makes the run say so, once, whether the bot was named by id or by name", () => {
    for (const named of ["books", "Bookkeeping", "@bookkeeping"]) {
      const { refused } = fixture();
      refused.settled("t", rooms, [named], 403, r1);
      expect(refused.take("t")).toBe(SAID);
      expect(refused.take("t")).toBeNull();
    }
  });

  it("stays quiet about anything that wasn't the refusal: a hand-off that went through, a typo, the bot itself, someone's own MausBot", () => {
    for (const [named, status] of [["Staff Hours", 202], ["Staff Hours", 403], ["Bookkeeper", 403], ["Rooms", 403], ["MausBot", 403], ["books", 202]] as const) {
      const { refused } = fixture();
      refused.settled("t", rooms, [named], status, r1);
      expect(refused.take("t"), named).toBeNull();
    }
  });

  it("forgets a refusal once the same bot was reached after all", () => {
    const { refused } = fixture();
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    refused.settled("t", rooms, ["books"], 202, r1);
    expect(refused.take("t")).toBeNull();
  });

  it("keeps nothing for a conversation that isn't a routine's run", () => {
    const { refused } = fixture({ run: false });
    refused.settled("t", rooms, ["Bookkeeping"], 403, undefined);
    expect(refused.take("t")).toBeNull();
  });

  it("keeps nothing for a call that returned after the run that made it was gone and another had started", () => {
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara" });
    const madeIn = r1;
    now(r2);
    refused.settled("t", rooms, ["Bookkeeping"], 403, madeIn);
    expect(refused.take("t"), "the run that started since never made that call").toBeNull();
    expect(lines).toEqual([]);
  });

  it("keeps nothing for a call made outside a routine that returned after a routine's run had started", () => {
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara", run: false });
    now(r2);
    refused.settled("t", rooms, ["Bookkeeping"], 403, undefined);
    expect(lines, "the run that started since wrote no routine that was refused").toEqual([]);
    expect(refused.take("t"), "the run that started since never made that call").toBeNull();
  });

  it("keeps a queued run's refusal when another run uses the conversation meanwhile and ends without taking", () => {
    const status = new Map<string, RoutineRunStatus>([["run_1", "queued"], ["run_2", "running"]]);
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara", status: (id) => status.get(id) });
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1); // its first start failed: it keeps its id and conversation to start again
    now(r2);
    refused.settled("t", rooms, ["Ledger"], 403, r2);
    status.set("run_2", "cancelled"); // cancelled without taking: nothing of its own is ever said
    status.set("run_1", "running");
    now(r1);
    expect(refused.take("t"), "the run still to finish says what it was refused").toBe(SAID);
    expect(lines.map((line) => line.to), "and its writer hears it, once").toEqual(["p_olive"]);
    expect(refused.take("t")).toBeNull();
  });

  it("says the ending run's refusal and leaves a run still queued its own for when it resumes", () => {
    const status = new Map<string, RoutineRunStatus>([["run_1", "running"], ["run_2", "queued"]]);
    const { refused, now } = fixture({ writer: "p_olive", asked: "p_mara", status: (id) => status.get(id) });
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    now(r2);
    refused.settled("t", rooms, ["Ledger"], 403, r2);
    now(r1);
    expect(refused.take("t"), "the run ending here says only its own").toBe(SAID);
    status.set("run_2", "running");
    now(r2);
    expect(refused.take("t"), "the run that was queued still says its own with the conversation back").toBe(LEDGER_SAID);
  });

  it("drops a finished run's refusal and never says it", () => {
    const status = new Map<string, RoutineRunStatus>([["run_1", "failed"]]);
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara", status: (id) => status.get(id) });
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    now(r2);
    status.set("run_2", "running");
    refused.settled("t", rooms, ["Ledger"], 403, r2);
    status.set("run_1", "running");
    now(r1);
    expect(refused.take("t"), "the run that finished before saying it kept nothing to say").toBeNull();
    expect(lines).toEqual([]);
  });

  it("says only the refusal of the run that holds the conversation after an abandoned run's is dropped", () => {
    const status = new Map<string, RoutineRunStatus>([["run_1", "failed"], ["run_2", "running"]]);
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara", status: (id) => status.get(id) });
    refused.settled("t", rooms, ["Ledger"], 403, r1);
    now(r2);
    refused.settled("t", rooms, ["Bookkeeping"], 403, r2);
    expect(refused.take("t")).toBe(SAID);
    expect(refused.take("t")).toBeNull();
    expect(lines.map((line) => line.to), "and its writer heard it once").toEqual(["p_olive"]);
  });

  it("still makes the run that made the call say so before the conversation moves on", () => {
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara" });
    const madeIn = r1;
    refused.settled("t1", rooms, ["Bookkeeping"], 403, madeIn);
    expect(refused.take("t1")).toBe(SAID);
    now(r2);
    refused.settled("t2", rooms, ["Bookkeeping"], 403, madeIn);
    const later = refused.take("t2");
    expect(lines.map((line) => line.to), "only the run that made the call told its writer").toEqual(["p_olive"]);
    expect(later, "the run that started since never made that call").toBeNull();
  });

  it("keeps a refusal when another run's delayed refusal for the same bot settles after it", () => {
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara" });
    now(r1);
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    now(r1);
    refused.settled("t", rooms, ["Bookkeeping"], 403, r2);
    expect(refused.take("t"), "the run that was refused still says so").toBe(SAID);
    expect(lines.map((line) => line.to), "and its writer still hears it, once").toEqual(["p_olive"]);
    expect(refused.take("t"), "the run that no longer owns the conversation says nothing").toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("keeps a refusal when another run's delayed success for the same bot settles after it", () => {
    const { refused, lines, now } = fixture({ writer: "p_olive", asked: "p_mara" });
    now(r1);
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    refused.settled("t", rooms, ["books"], 202, r2);
    expect(refused.take("t"), "another run reaching Bookkeeping did not reach it for this one").toBe(SAID);
    expect(lines.map((line) => line.to)).toEqual(["p_olive"]);
  });

  it("tells who wrote the routine in their inbox when the bot's failures reach someone else, once for the same words", () => {
    const { refused, lines } = fixture({ writer: "p_olive", asked: "p_mara" });
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    refused.take("t");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.to).toBe("p_olive");
    expect(lines[0]!.delivery).toMatchObject({ kind: "notice", quiet: false, title: "Rooms's routine couldn't hand off its work", text: SAID });
    refused.settled("t2", rooms, ["Bookkeeping"], 403, r1);
    refused.take("t2");
    expect(lines, "the next day's run says the same").toHaveLength(1);
  });

  it("reaches a person's inbox from a run of their own too, where the failure's own notification already tells them", () => {
    const { refused, lines } = fixture({ writer: "p_mara", asked: "p_mara", own: true });
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    refused.take("t");
    expect(lines.map((line) => [line.to, line.delivery.quiet])).toEqual([["p_mara", true]]);
  });

  it("sends no second line when the bot's failures already reach who wrote it", () => {
    const { refused, lines } = fixture({ writer: "p_olive", asked: "p_olive" });
    refused.settled("t", rooms, ["Bookkeeping"], 403, r1);
    refused.take("t");
    expect(lines).toEqual([]);
  });
});