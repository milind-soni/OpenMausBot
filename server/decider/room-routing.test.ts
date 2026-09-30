import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import {
  EVERYONE_OPTION, ROOM_ROUTING_TIMEOUT_MS, decideRoomResponder, memberOption, roomRoutingRequest, type RoomRoutingInput,
} from "./room-routing.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

const INPUT: RoomRoutingInput = {
  room: "#launch",
  humans: ["Milind", "Priya"],
  members: [
    { id: "bot-maya", name: "Maya", title: "Product Designer", description: "Owns UI mockups and the brand look." },
    { id: "bot-theo", name: "Theo", title: "Frontend Engineer", description: "Builds the web app in React." },
    { id: "bot-chief", name: "Chief", title: "Chief of Staff" },
  ],
  recent: [{ from: "Theo (bot)", text: "Pushed the new navbar to staging." }],
  message: { from: "Milind", text: "The signup button overlaps the footer on Safari mobile." },
};

type Choose = Decider["choose"];

function answering(result: DeciderResult<ChoiceAnswer>) {
  const choose = vi.fn(async () => result) as unknown as Choose & ReturnType<typeof vi.fn>;
  return { choose };
}

const picked = (choice: string, pTop: number): DeciderResult<ChoiceAnswer> =>
  ({ ok: true, provider: "jev", latencyMs: 340, answers: { type: "choice", choice, pTop, margin: pTop - 0.05, probabilities: { [choice]: pTop } } });

describe("room routing request", () => {
  it("offers every active member by id, plus __everyone__, in the bench's state shape", () => {
    const { state, question } = roomRoutingRequest(INPUT);
    expect(Object.keys(question.options)).toEqual(["bot-maya", "bot-theo", "bot-chief", EVERYONE_OPTION]);
    expect(question.options["bot-maya"]).toBe("Maya, Product Designer bot. Owns UI mockups and the brand look.");
    expect(question.options["bot-chief"]).toBe("Chief, Chief of Staff bot.");
    expect(question.instructions).toContain("`new_message`");
    expect(state).toEqual({
      room: "#launch",
      humans_in_room: ["Milind", "Priya"],
      bots_in_room: ["Maya", "Theo", "Chief"],
      recent_messages: [{ from: "Theo (bot)", text: "Pushed the new navbar to staging." }],
      new_message: { from: "Milind", text: "The signup button overlaps the footer on Safari mobile." },
    });
  });

  it("keeps the newest room lines within a size budget, each clipped", () => {
    const recent = Array.from({ length: 30 }, (_, i) => ({ from: "Milind", text: `line ${i} ${"x".repeat(900)}` }));
    const { state } = roomRoutingRequest({ ...INPUT, recent });
    const kept = state.recent_messages!;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(30);
    expect(kept.at(-1)!.text.startsWith("line 29")).toBe(true);
    expect(kept.every((line) => line.text.length <= 500)).toBe(true);
    expect(JSON.stringify(kept).length).toBeLessThan(8_000);
  });

  it("describes a bot on one line whatever its fields hold", () => {
    expect(memberOption({ id: "x", name: "  Nora\n", description: "Writes\ncopy." })).toBe("Nora bot. Writes copy.");
  });
});

describe("decideRoomResponder", () => {
  it("a confident pick answers alone", async () => {
    const decider = answering(picked("bot-theo", 0.94));
    await expect(decideRoomResponder(decider, INPUT)).resolves.toEqual({ kind: "member", botId: "bot-theo", probability: 0.94 });
    expect(decider.choose).toHaveBeenCalledWith("roomRouting", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: ROOM_ROUTING_TIMEOUT_MS }));
  });

  it("__everyone__ at 0.6 or above sends it to everyone", async () => {
    await expect(decideRoomResponder(answering(picked(EVERYONE_OPTION, 0.72)), INPUT)).resolves.toEqual({ kind: "everyone", probability: 0.72 });
  });

  it("exactly 0.6 is confident enough; below falls back", async () => {
    await expect(decideRoomResponder(answering(picked("bot-maya", 0.6)), INPUT)).resolves.toMatchObject({ kind: "member", botId: "bot-maya" });
    await expect(decideRoomResponder(answering(picked("bot-maya", 0.59)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "low_confidence" });
    await expect(decideRoomResponder(answering(picked(EVERYONE_OPTION, 0.55)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "low_confidence" });
  });

  it("any decider failure falls back with its reason", async () => {
    for (const reason of ["timeout", "overloaded", "malformed", "disabled"] as const) {
      await expect(decideRoomResponder(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ kind: "fallback", reason });
    }
  });

  it("a pick that is not an active member falls back", async () => {
    await expect(decideRoomResponder(answering(picked("bot-gone", 0.99)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("a decider that throws still yields a fallback", async () => {
    const choose = vi.fn(async () => { throw new Error("boom"); }) as unknown as Choose;
    await expect(decideRoomResponder({ choose }, INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("does not ask when there is nobody to choose between", async () => {
    const decider = answering(picked("bot-maya", 0.99));
    await expect(decideRoomResponder(decider, { ...INPUT, members: INPUT.members.slice(0, 1) })).resolves.toEqual({ kind: "fallback", reason: "no_choice" });
    expect(decider.choose).not.toHaveBeenCalled();
  });

  it("passes the room's Stop signal through", async () => {
    const decider = answering(picked("bot-maya", 0.9));
    const controller = new AbortController();
    await decideRoomResponder(decider, INPUT, { signal: controller.signal });
    expect(decider.choose).toHaveBeenCalledWith("roomRouting", expect.any(Object), expect.any(Object), expect.objectContaining({ signal: controller.signal }));
  });
});
