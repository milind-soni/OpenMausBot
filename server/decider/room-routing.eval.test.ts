// Live eval of room routing against the real decision model, on the bench's
// labelled room messages (fixtures/room-routing.json). It spends real money
// (about $0.002 a run: 53 calls of ~700 input tokens at $0.042/M), so it runs
// only when asked:
//
//   OMB_JEV_LIVE_EVAL=1 OMB_JEV_API_KEY=… npx vitest run server/decider/room-routing.eval.test.ts --reporter=default
//
// (--reporter=default keeps the printed summary visible where vitest would
// otherwise pick a quieter reporter, such as under a coding agent.)
//
// CI never sets the flag, so the suite is skipped there. It routes through the
// same request builder and threshold the server uses. The option set is the
// production one (members + __everyone__, no "nobody"), so messages labelled
// "nobody" are reported, not scored: an Auto room has no silent answer and
// they end with the lead, as a lead-mode room does today.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDecider } from "./index.ts";
import { decideRoomResponder, type RoomRoute, type RoomRoutingInput } from "./room-routing.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

interface Fixture {
  rooms: Record<string, { name: string; humans: string[]; members: RoomRoutingInput["members"] }>;
  items: Array<{ id: string; set: string; room: string; from?: string; recent?: RoomRoutingInput["recent"]; message: string; gold: string[] }>;
}

const LIVE = process.env.OMB_JEV_LIVE_EVAL === "1";
const KEY = process.env.OMB_JEV_API_KEY || process.env.TYPESAFE_API_KEY || "";
const PRICE_PER_M_INPUT = 0.042;

describe.skipIf(!LIVE)("room routing, live", () => {
  it("routes the bench's room messages", { timeout: 180_000 }, async () => {
    expect(KEY, "set OMB_JEV_API_KEY (or TYPESAFE_API_KEY) for the live eval").not.toBe("");
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "room-routing.json"), "utf8")) as Fixture;
    const real = createDecider({ config: () => ({ decider: { enabled: true, key: KEY, jobs: { roomRouting: true } } }) });
    const rows: Array<{ id: string; set: string; gold: string[]; route: RoomRoute; answer?: DeciderResult<ChoiceAnswer> }> = [];

    for (const item of fixture.items) {
      const room = fixture.rooms[item.room]!;
      let answer: DeciderResult<ChoiceAnswer> | undefined;
      const recorded = {
        choose: (async (...args: Parameters<typeof real.choose>) => (answer = await real.choose(...args) as DeciderResult<ChoiceAnswer>)) as typeof real.choose,
      };
      const input: RoomRoutingInput = {
        room: room.name, humans: room.humans, members: room.members, recent: item.recent ?? [],
        message: { from: item.from ?? "Milind", text: item.message },
      };
      // The production budget is 1.5 s; this measures the answer rather than cutting it.
      const route = await decideRoomResponder(recorded, input, { timeoutMs: 10_000 });
      rows.push({ id: item.id, set: item.set, gold: item.gold, route, answer });
    }

    const scored = rows.filter((row) => !row.gold.includes("nobody"));
    const correct = scored.filter((row) => row.route.kind === "member" && row.gold.includes(row.route.botId));
    const fellBack = scored.filter((row) => row.route.kind === "fallback");
    const confidentlyWrong = scored.filter((row) => row.route.kind !== "fallback" && !(row.route.kind === "member" && row.gold.includes(row.route.botId)));
    const failures = rows.filter((row) => !row.answer?.ok);
    const latencies = rows.flatMap((row) => row.answer?.latencyMs ?? []).sort((a, b) => a - b);
    const tokens = rows.reduce((sum, row) => sum + (row.answer?.ok ? row.answer.inputTokens ?? 0 : 0), 0);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
    const summarize = (row: (typeof rows)[number]) => {
      const answered = row.answer?.ok ? `${row.answer.answers.choice}@${row.answer.answers.pTop}` : row.answer?.reason;
      return `${row.id} gold=${row.gold.join("|")} route=${row.route.kind === "member" ? row.route.botId : row.route.kind} (${answered})`;
    };
    console.log([
      `room routing live eval: ${correct.length}/${scored.length} routed right, ${fellBack.length} fell back to the lead, ${confidentlyWrong.length} routed wrong`,
      `"nobody" messages (${rows.length - scored.length}): ${rows.filter((row) => row.gold.includes("nobody")).map((row) => row.route.kind).join(", ")}`,
      `latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, over 1.5 s: ${latencies.filter((ms) => ms > 1_500).length}`,
      `input tokens ${tokens} ≈ $${((tokens / 1e6) * PRICE_PER_M_INPUT).toFixed(4)}`,
      ...confidentlyWrong.map((row) => `WRONG ${summarize(row)}`),
      ...fellBack.map((row) => `FALLBACK ${summarize(row)}`),
    ].join("\n"));

    expect(failures.map(summarize)).toEqual([]);
    expect(correct.length / scored.length).toBeGreaterThanOrEqual(0.85);
    expect(confidentlyWrong.length).toBeLessThanOrEqual(2);
  });
});
