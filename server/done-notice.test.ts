import { describe, expect, it } from "vitest";

import { createDoneNotice } from "./done-notice.ts";

const notice = (state: { awaiting?: Set<string>; queued?: Set<string> } = {}) => createDoneNotice({
  awaitingTeammates: (threadId) => state.awaiting?.has(threadId) ?? false,
  queuedFollowUp: (_botId, threadId) => state.queued?.has(threadId) ?? false,
});
const turn = (patch: Partial<Parameters<ReturnType<typeof notice>["atTurnEnd"]>[0]> = {}) =>
  ({ botId: "pen", threadId: "t", review: false, ok: true, routine: false, ...patch });

describe("when a turn's end is news", () => {
  it("notifies a plain finished turn, as before", () => {
    expect(notice().atTurnEnd(turn())).toBe("notify");
  });

  it("holds the done of a turn that handed work off, and notifies once when the reviewed answer lands", () => {
    const awaiting = new Set(["t"]);
    const done = notice({ awaiting });
    expect(done.atTurnEnd(turn())).toBe("hold");
    expect(done.owes("t")).toBe(true);
    awaiting.clear();
    expect(done.atTurnEnd(turn({ review: true }))).toBe("notify");
    expect(done.owes("t")).toBe(false);
    expect(done.atTurnEnd(turn({ review: true }))).toBe("quiet");
  });

  it("keeps holding through a review that hands work off again, and notifies at the last round's answer", () => {
    const awaiting = new Set(["t"]);
    const done = notice({ awaiting });
    expect(done.atTurnEnd(turn())).toBe("hold");
    expect(done.atTurnEnd(turn({ review: true }))).toBe("hold");
    awaiting.clear();
    expect(done.atTurnEnd(turn({ review: true }))).toBe("notify");
  });

  it("keeps a review nobody held a done for quiet, like an incident review", () => {
    expect(notice().atTurnEnd(turn({ review: true }))).toBe("quiet");
  });

  it("lets a failed review clear the debt quietly: its failure notifies on its own", () => {
    const done = notice({ awaiting: new Set(["t"]) });
    done.atTurnEnd(turn());
    expect(done.atTurnEnd(turn({ review: true, ok: false }))).toBe("quiet");
    expect(done.owes("t")).toBe(false);
  });

  it("holds the done of a turn the person's queued message continues", () => {
    expect(notice({ queued: new Set(["t"]) }).atTurnEnd(turn())).toBe("hold");
  });

  it("forgets what a stopped hand-off owed once the person starts a new turn", () => {
    const done = notice({ awaiting: new Set(["t"]) });
    done.atTurnEnd(turn());
    done.personTurnStarted("t");
    expect(done.atTurnEnd(turn({ review: true }))).toBe("quiet");
  });

  it("leaves routine runs to their own rules", () => {
    expect(notice({ awaiting: new Set(["t"]), queued: new Set(["t"]) }).atTurnEnd(turn({ routine: true }))).toBe("notify");
  });
});
