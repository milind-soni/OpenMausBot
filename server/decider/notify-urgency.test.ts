import { describe, expect, it, vi } from "vitest";

import type { Notification, NotifyKind } from "../../shared/notification.ts";
import type { Decider } from "./index.ts";
import { NOTIFY_URGENCY } from "./jobs.ts";
import {
  QUIET_MIN_PROBABILITY, decideNotificationQuiet, notificationQuietable, notifyUrgencyRequest,
} from "./notify-urgency.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

const DONE: Notification = {
  kind: "done",
  botId: "bot-1",
  botName: "Scout",
  threadId: "thread-1",
  title: "Scout finished",
  body: "Renamed the three screenshots and put them in Pictures/2026.",
  avatarUrl: "/api/avatars/bot-1.png",
};

type Choose = Decider["choose"];

function answering(result: DeciderResult<ChoiceAnswer>) {
  const choose = vi.fn(async () => result) as unknown as Choose & ReturnType<typeof vi.fn>;
  return { choose };
}

const picked = (choice: string, pTop: number): DeciderResult<ChoiceAnswer> =>
  ({ ok: true, provider: "jev", latencyMs: 250, answers: { type: "choice", choice, pTop, margin: pTop - (1 - pTop), probabilities: { [choice]: pTop } } });

describe("which notifications may be asked about", () => {
  it("only reports of finished work", () => {
    expect(notificationQuietable(DONE)).toBe(true);
    expect(notificationQuietable({ ...DONE, kind: "delegation-settled" })).toBe(true);
    const never: NotifyKind[] = ["approval", "question", "takeover", "turn-failed", "routine-failed", "routine-deferred", "incident", "spend", "stuck"];
    for (const kind of never) expect(notificationQuietable({ ...DONE, kind }), kind).toBe(false);
  });

  it("not one that is quiet already", () => {
    expect(notificationQuietable({ ...DONE, quiet: true })).toBe(false);
  });
});

describe("notification urgency request", () => {
  it("asks the contract's exact question with only its state keys", () => {
    const { state, question } = notifyUrgencyRequest(DONE);
    expect(question).toEqual({ instructions: NOTIFY_URGENCY.instructions, options: NOTIFY_URGENCY.options });
    expect(state).toEqual({ notification: { kind: "done", bot: "Scout", title: "Scout finished", body: DONE.body } });
    expect(relayAccepts("notifyUrgency", state, { answer: { type: "choice", ...question } })).toBe(true);
  });

  it("a huge notification still fits the relay's caps", () => {
    const { state, question } = notifyUrgencyRequest({ ...DONE, botName: "b".repeat(5_000), title: "t".repeat(5_000), body: "ü".repeat(50_000) });
    expect(state.notification.body.length).toBeLessThanOrEqual(1_000);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("notifyUrgency", state, { answer: { type: "choice", ...question } })).toBe(true);
  });
});

describe("decideNotificationQuiet", () => {
  it(`quietens on "later" at ${QUIET_MIN_PROBABILITY} or above, changing nothing else`, async () => {
    const decider = answering(picked("later", 0.82));
    await expect(decideNotificationQuiet(decider, DONE)).resolves.toEqual({ ...DONE, quiet: true });
    expect(decider.choose).toHaveBeenCalledWith("notifyUrgency", expect.any(Object), expect.any(Object), { timeoutMs: NOTIFY_URGENCY.timeoutMs });
    await expect(decideNotificationQuiet(answering(picked("later", 0.7)), DONE)).resolves.toMatchObject({ quiet: true });
  });

  it("sends as today when less sure, or urgent", async () => {
    await expect(decideNotificationQuiet(answering(picked("later", 0.69)), DONE)).resolves.toBe(DONE);
    await expect(decideNotificationQuiet(answering(picked("urgent", 0.95)), DONE)).resolves.toBe(DONE);
    await expect(decideNotificationQuiet(answering(picked("something", 0.99)), DONE)).resolves.toBe(DONE);
  });

  it("any failure sends as today", async () => {
    for (const reason of ["timeout", "overloaded", "malformed", "disabled"] as const) {
      await expect(decideNotificationQuiet(answering({ ok: false, reason }), DONE)).resolves.toBe(DONE);
    }
    const choose = vi.fn(async () => { throw new Error("boom"); }) as unknown as Choose;
    await expect(decideNotificationQuiet({ choose }, DONE)).resolves.toBe(DONE);
  });

  it("never asks about, or quietens, one that needs the person", async () => {
    const decider = answering(picked("later", 0.99));
    for (const kind of ["approval", "question", "takeover", "turn-failed", "incident", "stuck"] as const) {
      const notification = { ...DONE, kind };
      await expect(decideNotificationQuiet(decider, notification)).resolves.toBe(notification);
    }
    expect(decider.choose).not.toHaveBeenCalled();
  });
});
