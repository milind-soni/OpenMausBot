import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../shared/notification.ts";
import { flushDecisionLog, readDecisions } from "./decision-log.ts";
import { OutboundCounts } from "./outbound-counts.ts";
import { createOutboundHold, type OutboundHold, type OutboundHoldDeps } from "./outbound-hold.ts";
import { OutboundRequestService } from "./outbound-requests.ts";

type HoldBot = Parameters<OutboundHold["hold"]>[0]["bot"];

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const calls = [{ slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Hello" } }];

function setup(bot: HoldBot) {
  const dataDir = mkdtempSync(join(tmpdir(), "outbound-hold-"));
  dirs.push(dataDir);
  const appended: Array<{ threadId: string; message: { id: string; card?: Record<string, unknown> } & Record<string, unknown> }> = [];
  const patches: Array<{ threadId: string; messageId: string; patch: Record<string, unknown> }> = [];
  const activity: string[] = [];
  const notified: Array<Notification | null> = [];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${appended.length + 1}` };
      appended.push({ threadId, message: row });
      return row;
    },
    bot: (id: string) => (id === bot.id ? bot : undefined),
    messagesFor: (threadId: string) => appended.filter((entry) => entry.threadId === threadId).map((entry) => entry.message),
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      patches.push({ threadId, messageId, patch });
      return null;
    },
    setActivity: (_botId: string, value: string) => {
      activity.push(`bot:${value}`);
      return null;
    },
    setTaskActivity: (_botId: string, _threadId: string, value: string) => {
      activity.push(`task:${value}`);
      return null;
    },
    taskByThread: () => ({ busy: true }),
  };
  const outboundRequests = new OutboundRequestService();
  const outboundCounts = new OutboundCounts(join(dataDir, "outbound-counts.json"));
  const deps: OutboundHoldDeps = {
    store: store as unknown as OutboundHoldDeps["store"],
    dataDir,
    outboundRequests,
    outboundCounts,
    holdMs: 1_000,
    connectorThread: () => ({ group: undefined }),
    activeGroupTurnForBot: () => null,
    notify: (notification) => notified.push(notification),
  };
  const input = { bot, threadId: "t1", tool: "GMAIL_SEND_EMAIL", calls, opaque: false, fullAccess: false };
  return { hold: createOutboundHold(deps), dataDir, appended, patches, activity, notified, outboundRequests, input };
}

const bot = (outbound: HoldBot["outbound"], notifications = true): HoldBot => ({ id: "b1", name: "Scout", color: "green", outbound, notifications });

describe("createOutboundHold", () => {
  it("allow policy under the cap approves without a card and records the row", async () => {
    const { hold, dataDir, appended, notified, input } = setup(bot({ policy: "allow", dailyCap: 2 }));
    await expect(hold.hold({ ...input, active: () => true })).resolves.toEqual({ ok: true, approved: false });
    expect(appended).toEqual([]);
    expect(notified).toEqual([]);

    hold.reserve({ ...input, approved: false });
    hold.reserve({ ...input, approved: false });
    expect(() => hold.reserve({ ...input, approved: false })).toThrow(/daily outbound limit/);

    await flushDecisionLog(dataDir);
    const rows = readDecisions(dataDir, 10);
    expect(rows.map((row) => row.rule)).toEqual(["daily-allowance:1/2", "daily-allowance:2/2"]);
    expect(rows[0]).toMatchObject({ threadId: "t1", botId: "b1", botName: "Scout", tool: "GMAIL_SEND_EMAIL", decision: "auto-approved", source: "outbound" });

    // The cap is spent: the next hold refuses before any card.
    await expect(hold.hold({ ...input, active: () => true })).resolves.toMatchObject({ ok: false, text: expect.stringMatching(/daily limit of 2 outbound actions/) });
  });

  it("ask policy posts the card and resolves on allow", async () => {
    const { hold, dataDir, appended, activity, notified, outboundRequests, input } = setup(bot({ policy: "ask", dailyCap: 10 }));
    const pending = hold.hold({ ...input, active: () => true });

    expect(appended).toHaveLength(1);
    const card = appended[0].message;
    expect(appended[0].threadId).toBe("t1");
    expect(card).toMatchObject({
      role: "bot",
      kind: "options",
      card: {
        title: "Send on your behalf?",
        options: ["Allow", "Deny"],
        requestId: expect.any(String),
        tool: "GMAIL_SEND_EMAIL",
        heldCode: "approval.held.outbound",
        outboundRequest: { tool: "GMAIL_SEND_EMAIL", app: "Gmail" },
      },
    });
    expect(card).not.toHaveProperty("from");
    expect(activity).toEqual(["task:waiting-on-you"]);
    expect(notified).toMatchObject([{ kind: "approval", botId: "b1", threadId: "t1" }]);

    const requestId = card.card!.requestId as string;
    expect(outboundRequests.resolve({ threadId: "t1", requestId, behavior: "allow" })).toEqual({ claimed: true, state: "allowed" });
    await expect(pending).resolves.toEqual({ ok: true, approved: true });
    expect(outboundRequests.pending("t1")).toEqual([]);

    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toMatchObject([{ requestId, decision: "card-shown", source: "outbound", tool: "GMAIL_SEND_EMAIL" }]);
    // An approved hold lets the dispatch through without spending the allowance.
    expect(() => hold.reserve({ ...input, bot: bot({ policy: "ask", dailyCap: 10 }), approved: true })).not.toThrow();

    // A bot the user muted still posts the card, but sends no notification.
    const muted = setup(bot({ policy: "ask", dailyCap: 10 }, false));
    const mutedPending = muted.hold.hold({ ...muted.input, active: () => true });
    expect(muted.appended).toHaveLength(1);
    expect(muted.notified).toEqual([null]);
    muted.outboundRequests.resolve({ threadId: "t1", requestId: muted.appended[0].message.card!.requestId as string, behavior: "allow" });
    await expect(mutedPending).resolves.toEqual({ ok: true, approved: true });
  });

  it("deny answers the decline text; timeout marks the card unavailable", async () => {
    const denied = setup(bot(undefined));
    const pending = denied.hold.hold({ ...denied.input, active: () => true });
    const requestId = denied.appended[0].message.card!.requestId as string;
    denied.outboundRequests.resolve({ threadId: "t1", requestId, behavior: "deny" });
    await expect(pending).resolves.toEqual({ ok: false, text: expect.stringMatching(/the user declined/) });
    expect(denied.patches).toEqual([]);

    vi.useFakeTimers();
    const timed = setup(bot(undefined));
    const waiting = timed.hold.hold({ ...timed.input, active: () => true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ ok: false, text: expect.stringMatching(/nobody answered/) });
    expect(timed.patches).toHaveLength(1);
    expect(timed.patches[0]).toMatchObject({ threadId: "t1", messageId: timed.appended[0].message.id, patch: { card: { answered: "unavailable", dismissed: true, title: "Send on your behalf?" } } });
  });

  it("reserve refuses when the hold was not approved and the policy is ask", async () => {
    const { hold, dataDir, input } = setup(bot({ policy: "ask", dailyCap: 10 }));
    expect(() => hold.reserve({ ...input, fullAccess: false, approved: false })).toThrow(/outbound policy changed/);

    // Full access sends freely and logs it.
    expect(() => hold.reserve({ ...input, fullAccess: true, approved: false })).not.toThrow();
    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toMatchObject([{ decision: "auto-approved", source: "outbound", rule: "full-access" }]);
  });
});
