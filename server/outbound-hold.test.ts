import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../shared/notification.ts";
import { flushDecisionLog, readDecisions } from "./decision-log.ts";
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
  const deps: OutboundHoldDeps = {
    store: store as unknown as OutboundHoldDeps["store"],
    dataDir,
    outboundRequests,
    holdMs: 1_000,
    connectorThread: () => ({ group: undefined }),
    activeGroupTurnForBot: () => null,
    notify: (notification) => notified.push(notification),
  };
  const input = { bot, threadId: "t1", tool: "GMAIL_SEND_EMAIL", calls, opaque: false, fullAccess: false };
  return { hold: createOutboundHold(deps), dataDir, appended, patches, activity, notified, outboundRequests, input };
}

const bot = (outbound: HoldBot["outbound"], notifications = true): HoldBot => ({ id: "b1", name: "Scout", color: "green", outbound, notifications });

/** One send as the relay makes it: the hold, then the check at dispatch. */
const send = async (held: ReturnType<typeof setup>, options: { fullAccess?: boolean; opaque?: boolean } = {}) => {
  const input = { ...held.input, ...options };
  const answer = await held.hold.hold({ ...input, active: () => true });
  if (answer.ok) held.hold.beforeDispatch({ ...input, approved: answer.approved });
  return answer;
};

describe("createOutboundHold", () => {
  it("Send without asking sends 40 in a day with no card and no refusal, and records each one", async () => {
    const held = setup(bot({ policy: "allow" }));
    for (let sent = 0; sent < 40; sent++) await expect(send(held)).resolves.toEqual({ ok: true, approved: false });
    expect(held.appended).toEqual([]);
    expect(held.notified).toEqual([]);

    await flushDecisionLog(held.dataDir);
    const rows = readDecisions(held.dataDir, 100);
    expect(rows).toHaveLength(40);
    expect(rows.every((row) => row.decision === "auto-approved" && row.source === "outbound" && row.rule === "allow")).toBe(true);
    expect(rows[0]).toMatchObject({ threadId: "t1", botId: "b1", botName: "Scout", tool: "GMAIL_SEND_EMAIL" });
  });

  it("ignores a daily cap an older app stored on the rule", async () => {
    const held = setup(bot({ policy: "allow", dailyCap: 2 } as HoldBot["outbound"]));
    for (let sent = 0; sent < 5; sent++) await expect(send(held)).resolves.toEqual({ ok: true, approved: false });
    expect(held.appended).toEqual([]);
  });

  it("ask policy posts the card and resolves on allow", async () => {
    const { hold, dataDir, appended, activity, notified, outboundRequests, input } = setup(bot({ policy: "ask" }));
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
    expect(() => hold.beforeDispatch({ ...input, bot: bot({ policy: "ask" }), approved: true })).not.toThrow();

    // A bot the user muted still posts the card, but sends no notification.
    const muted = setup(bot({ policy: "ask" }, false));
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

  it("refuses at dispatch when the hold was not approved and the policy is ask", async () => {
    const { hold, input } = setup(bot({ policy: "ask" }));
    expect(() => hold.beforeDispatch({ ...input, fullAccess: false, approved: false })).toThrow(/outbound policy changed/);
  });
});

describe("Full access with no sending rule of its own", () => {
  it("sends 40 in a day without a card or a refusal", async () => {
    const held = setup(bot(undefined));
    for (let sent = 0; sent < 40; sent++) await expect(send(held, { fullAccess: true })).resolves.toEqual({ ok: true, approved: false });
    expect(held.appended, "never a card").toEqual([]);
    expect(held.notified).toEqual([]);
    expect(held.outboundRequests.pending("t1")).toEqual([]);
    await flushDecisionLog(held.dataDir);
    const rules = readDecisions(held.dataDir, 100).map((row) => row.rule);
    expect(rules).toEqual(Array(40).fill("full-access"));
  });

  it("keeps a stored rule exactly as set: ask still asks, allow sends without asking", async () => {
    const asking = setup(bot({ policy: "ask" }));
    for (let round = 0; round < 3; round++) {
      const pending = send(asking, { fullAccess: true });
      expect(asking.appended).toHaveLength(round + 1);
      asking.outboundRequests.resolve({ threadId: "t1", requestId: asking.appended[round].message.card!.requestId as string, behavior: "allow" });
      await expect(pending).resolves.toEqual({ ok: true, approved: true });
    }

    const allowing = setup(bot({ policy: "allow" }));
    for (let sent = 0; sent < 40; sent++) await expect(send(allowing, { fullAccess: true })).resolves.toEqual({ ok: true, approved: false });
    expect(allowing.appended).toEqual([]);
  });

  it("sends a call it cannot inspect without a card, while Send without asking still asks for one", async () => {
    const held = setup(bot(undefined));
    for (let sent = 0; sent < 30; sent++) await expect(send(held, { fullAccess: true, opaque: true })).resolves.toEqual({ ok: true, approved: false });
    expect(held.appended).toEqual([]);

    const allowing = setup(bot({ policy: "allow" }));
    const pending = allowing.hold.hold({ ...allowing.input, opaque: true, fullAccess: true, active: () => true });
    expect(allowing.appended).toHaveLength(1);
    allowing.outboundRequests.resolve({ threadId: "t1", requestId: allowing.appended[0].message.card!.requestId as string, behavior: "deny" });
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
});
