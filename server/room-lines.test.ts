import { describe, expect, it } from "vitest";

import { roomResetNote } from "./room-context.ts";
import { heldMemberLine, isHeldMemberLine } from "./room-holds.ts";
import { finishedWithoutSummaryLine } from "./room-reply.ts";
import { roomTurnTimeoutMessage } from "./room-turn-timeout.ts";
import "./server-line-packs.ts";
import { isServerLine } from "./server-lines.ts";
import { HARNESS_NOTICE } from "./sentinel/normalize.ts";
import { toolError } from "./sentinel/detectors/tool-error.ts";
import { turnStop } from "./sentinel/detectors/turn-stop.ts";
import type { DetectorConfig, SentinelRecord } from "./sentinel/types.ts";

describe("a room's status rows", () => {
  it("read in the room's language, and in English for a coordinator", () => {
    expect(heldMemberLine("Biber", "de")).toBe("Biber ist angehalten (von dir gestoppt). Erwähne ihn mit @ oder schreib „resume“");
    expect(heldMemberLine("Biber")).toBe("Biber is held (stopped by you) — @mention it or say resume");
    expect(finishedWithoutSummaryLine("Biber", true, "de")).toBe("Biber ist ohne Zusammenfassung fertig geworden, ich frage nach einem kurzen Ergebnis");
    expect(roomTurnTimeoutMessage("Biber", 1, "de")).toBe("Biber kam im Raum 1 Minute lang nicht voran und wurde gestoppt");
    expect(roomTurnTimeoutMessage("Biber", 20, "de")).toBe("Biber kam im Raum 20 Minuten lang nicht voran und wurde gestoppt");
    expect(roomResetNote("Biber", { reason: "threshold", percent: 92 }, "de"))
      .toBe("Der Kontext von Biber war zu 92 % voll: komprimiert zu einer neuen Sitzung mit den letzten Nachrichten des Raums");
  });

  it("are recognized in every language when read back", () => {
    expect(isHeldMemberLine(heldMemberLine("Biber", "de"))).toBe(true);
    expect(isHeldMemberLine(heldMemberLine("Ada Lovelace", "ja"))).toBe(true);
    expect(isHeldMemberLine("Biber is busy in another conversation — skipped this round")).toBe(false);
    expect(isServerLine("server.rooms.postedIn", "Gepostet in Standup")).toBe(true);
    expect(isServerLine("server.rooms.postedIn", "Posted in Standup")).toBe(true);
    expect(isServerLine("server.rooms.postedIn", "Posted Standup")).toBe(false);
  });
});

describe("the sentinel reading a German room", () => {
  const config: DetectorConfig = { queueWaitMs: 300_000, costUsd: 5, retryLoopMin: 3, now: 10_000_000 };
  // As sentinel/sources.ts reads a status row: a harness notice with the bots' names taken out.
  const notice = (id: string, text: string): SentinelRecord => ({ type: "tool", id, threadId: "room", at: 1, ok: false, tool: HARNESS_NOTICE, text });

  it("counts a stopped room turn as a timeout, and a held member as no failure", () => {
    const stopped = notice("m1", roomTurnTimeoutMessage("<bot>", 5, "de"));
    expect(turnStop.detect([stopped], config).map((one) => one.kind)).toEqual(["turn_timeout"]);
    expect(toolError.detect([stopped], config)).toEqual([]);
    expect(toolError.detect([notice("m2", heldMemberLine("<bot>", "de"))], config)).toEqual([]);
    expect(toolError.detect([notice("m3", "Ein Werkzeug ist abgestürzt")], config)).toHaveLength(1);
  });
});
