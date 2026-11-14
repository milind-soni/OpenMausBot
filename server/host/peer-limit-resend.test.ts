import { describe, expect, it, vi } from "vitest";
import type { Message } from "../store.ts";
import { createPeerLimitResend, nothingRan, type PeerLimitResendDeps, type PeerTurnOpts } from "./peer-limit-resend.ts";

type Outcome = { ok: boolean; text: string };
type Opts = PeerTurnOpts<Outcome> & { origin?: { kind: string } };

const ask: Message = { id: "ask-1", at: 100, role: "user", kind: "text", text: "Check the build", peerAsk: { botId: "chief", name: "Chief" } } as Message;
const LATER = Date.now() + 3_600_000;
const failure: Message = { id: "f", at: LATER, role: "bot", kind: "activity", tool: { name: "You've hit your usage limit", ok: false } } as Message;
const toolCall: Message = { id: "x", at: LATER, role: "bot", kind: "activity", turnId: "turn-1", tool: { name: "Bash", itemId: "item-1" } } as Message;
const reply: Message = { id: "r", at: LATER, role: "bot", kind: "text", turnId: "turn-1", text: "Half done" } as Message;
const LIMIT = "You've hit your usage limit";

describe("nothingRan", () => {
  it("counts only what the turn did, never its own limit failure", () => {
    expect(nothingRan([ask, failure], 100, "turn-1")).toBe(true);
    // Some engines send the limit sentence as reply text.
    expect(nothingRan([{ ...reply, text: LIMIT }], 100, "turn-1", LIMIT)).toBe(true);
    expect(nothingRan([toolCall, failure], 100, "turn-1")).toBe(false);
    expect(nothingRan([reply, failure], 100, "turn-1")).toBe(false);
    expect(nothingRan([{ ...reply, kind: "widget" } as Message], 100, "turn-1")).toBe(false);
    // The digest written after the turn ends only sums it up.
    expect(nothingRan([failure, { ...reply, kind: "digest", text: "[digest] · no tool activity observed in this turn" } as Message], 100, "turn-1")).toBe(true);
  });

  it("ignores rows from before the turn, from another turn, and the hand-off's request card", () => {
    expect(nothingRan([{ ...toolCall, at: 50 }], 100, "turn-1")).toBe(true);
    expect(nothingRan([{ ...toolCall, turnId: "turn-0" }], 100, "turn-1")).toBe(true);
    // The request card is written just before the turn, sometimes in the same millisecond.
    expect(nothingRan([{ ...reply, at: Date.now() + 1_000, turnId: undefined, text: "@Helper Check the build", roomRequest: { id: "r1", phase: "request" } } as Message, failure], 100, "turn-1")).toBe(true);
  });
});

/** One bot on Claude with Codex as its backup, and a thread whose rows the test sets. */
function fixture(rows: Message[] = [], overrides: Partial<PeerLimitResendDeps<Opts, Outcome>> = {}, stopReason = "error") {
  const bot = { id: "helper", threadId: "t1", modelSelection: { instanceId: "claude", model: "opus" } };
  const engine = (instanceId: string, driverKind: string) => ({ instanceId, driverKind, displayName: driverKind, enabled: true, adapter: { capabilities: {} } });
  let generation: string | undefined = "gen-1";
  const startTurn = vi.fn(async (_botId: string, _text: string, _opts: Opts) => undefined);
  const settle = vi.fn((_generation: string, _outcome: Outcome) => undefined);
  const switchTaskModel = vi.fn();
  const appended: Message[] = [];
  const deps = {
    store: {
      botByThread: () => bot, projectBotForTask: () => bot, taskByThread: () => ({ cwd: "/work" }),
      activePath: () => rows, appendMessage: (_threadId: string, row: Message) => { appended.push(row); return row; }, switchTaskModel,
    },
    registry: { get: (id: string) => id === "codex" ? engine("codex", "codex") : engine("claude", "claude") },
    takeover: () => ({ backups: () => [{ instanceId: "codex", model: "gpt" }], carriedOn: () => [{ name: "recovery: Claude is at its limit, Codex carries on", ok: true }] }),
    turnStops: { read: () => ({ error: `Claude says: ${LIMIT}`, flags: { limit: "engine" } }), failureCause: () => `Claude says: ${LIMIT}` },
    hostedModels: null,
    providerConfigs: () => ({}),
    quotaSwitchEnabled: () => true,
    policyModelRefusal: () => undefined,
    checkedTaskModelSwitch: (_bot: unknown, selection: unknown) => ({ ok: true, selection }),
    assertWithinBudget: () => undefined,
    handedOff: (id: string) => id === "child",
    guest: () => false,
    generation: () => generation,
    blocked: () => false,
    settle, release: vi.fn(), failedLine: (_threadId: string, detail: string) => `Could not resend this to the backup AI: ${detail}`, startTurn,
    ...overrides,
  } as unknown as PeerLimitResendDeps<Opts, Outcome>;
  const resend = createPeerLimitResend<Opts, Outcome>(deps);
  const failed = { type: "turn.completed", threadId: "t1", turnId: "turn-1", ok: false, stopReason } as const;
  return { resend, startTurn, settle, switchTaskModel, appended, failed, newGeneration: () => { generation = "gen-2"; } };
}
const peerOpts: Opts = { peerAsk: ask.peerAsk, origin: { kind: "outside" } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("peer limit resend", () => {
  it("resends a peer turn once on the backup when its limit came before anything ran, with its options unchanged", async () => {
    const { resend, startTurn, settle, switchTaskModel, failed } = fixture([ask, failure]);
    resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "Check the build", opts: peerOpts, userMessage: ask, latestUser: "ask-1" });
    resend.ended(failed, "gen-1", false);
    expect(resend.hold("gen-1", { ok: false, text: "limit" })).toBe(true);
    expect(resend.resend("t1")).toBe(true);
    await flush();
    expect(switchTaskModel).toHaveBeenCalledWith("helper", "t1", { instanceId: "codex", model: "gpt" }, false, false, { rewound: true });
    expect(startTurn).toHaveBeenCalledTimes(1);
    const [, text, opts] = startTurn.mock.calls[0];
    expect(text).toBe("Check the build");
    // Still the sender's line, never the person's: the same provenance, only marked as the one resend.
    expect(opts).toEqual({ ...peerOpts, threadId: "t1", userMessage: ask, editedMessageId: undefined, peerLimitResent: true });
    expect(opts.peerAsk).toBe(peerOpts.peerAsk);
    expect(opts.origin).toBe(peerOpts.origin);
    expect(settle).not.toHaveBeenCalled();
    // Once only.
    expect(resend.resend("t1")).toBe(false);
  });

  it("tracks only a relayed ask or a teammate's hand-off, never the person's own request, a routine's, a guest's or a resend", () => {
    const person = { ...ask, peerAsk: undefined } as Message;
    const cases: Array<[Opts, Message, boolean]> = [
      [peerOpts, ask, true],
      [{ coordination: { id: "child" } }, ask, true],
      [{}, person, false],
      [{ coordination: { id: "root" } }, person, false],
      [{ ...peerOpts, automationSource: { kind: "routine" } }, ask, false],
      [{ ...peerOpts, peerLimitResent: true }, ask, false],
      [{ coordination: { id: "child", resumed: true } }, ask, false],
    ];
    for (const [opts, userMessage, tracked] of cases) {
      const { resend, failed } = fixture([userMessage, failure]);
      resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts, userMessage });
      resend.ended(failed, "gen-1", false);
      expect(resend.hold("gen-1", { ok: false, text: "limit" }), JSON.stringify(opts)).toBe(tracked);
    }
    const guest = fixture([ask, failure], { guest: () => true });
    guest.resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts: peerOpts, userMessage: ask });
    guest.resend.ended(guest.failed, "gen-1", false);
    expect(guest.resend.hold("gen-1", { ok: false, text: "limit" })).toBe(false);
  });

  it("never resends after a tool call or a reply, or for a sign-out or any other failure", () => {
    const signedOut = { turnStops: { read: () => ({ error: "Not signed in" }), failureCause: () => "Not signed in" } } as never;
    const otherFailure = { turnStops: { read: () => ({ error: "Something broke" }), failureCause: () => "Something broke" } } as never;
    for (const [rows, overrides, stopReason] of [[[ask, toolCall, failure], {}, "error"], [[ask, reply, failure], {}, "error"], [[ask, failure], signedOut, "auth_required"], [[ask, failure], otherFailure, "error"]] as const) {
      const { resend, startTurn, failed } = fixture([...rows], overrides, stopReason);
      resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts: peerOpts, userMessage: ask });
      resend.ended(failed, "gen-1", false);
      expect(resend.hold("gen-1", { ok: false, text: "limit" })).toBe(false);
      expect(resend.resend("t1")).toBe(false);
      expect(startTurn).not.toHaveBeenCalled();
    }
  });

  it("reports the held failure as before when no backup can take it or a newer turn took the thread", async () => {
    const none = fixture([ask, failure], { takeover: () => ({ backups: () => [], carriedOn: () => [] }) } as never);
    none.resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts: peerOpts, userMessage: ask });
    none.resend.ended(none.failed, "gen-1", false);
    none.resend.hold("gen-1", { ok: false, text: "limit" });
    expect(none.resend.resend("t1")).toBe(true);
    await flush();
    expect(none.startTurn).not.toHaveBeenCalled();
    expect(none.settle).toHaveBeenCalledWith("gen-1", { ok: false, text: "limit" });

    const replaced = fixture([ask, failure]);
    replaced.resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts: peerOpts, userMessage: ask });
    replaced.resend.ended(replaced.failed, "gen-1", false);
    replaced.resend.hold("gen-1", { ok: false, text: "limit" });
    replaced.newGeneration();
    expect(replaced.resend.resend("t1")).toBe(false);
    expect(replaced.settle).toHaveBeenCalledWith("gen-1", { ok: false, text: "limit" });
    expect(replaced.startTurn).not.toHaveBeenCalled();
  });
  it("resends a turn whose end came before its dispatch named it, whether the thread settled before or after the bind", async () => {
    for (const settleFirst of [false, true]) {
      const { resend, startTurn, settle, failed } = fixture([ask, failure]);
      resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "Check the build", opts: peerOpts, userMessage: ask });
      // turn.completed arrives with no bound owner: nothing is judged yet.
      resend.endedUnbound(failed, false);
      if (settleFirst) expect(resend.resend("t1", "gen-1")).toBe(false);
      resend.bound("t1", "turn-1", "gen-1");
      expect(resend.hold("gen-1", { ok: false, text: "limit" }), `settleFirst=${settleFirst}`).toBe(true);
      if (!settleFirst) expect(resend.resend("t1", "gen-1")).toBe(true);
      await flush(); await flush();
      expect(startTurn, `settleFirst=${settleFirst}`).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
    }
  });

  it("ignores an early end for another turn id when the dispatch binds", () => {
    const { resend, failed } = fixture([ask, failure]);
    resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts: peerOpts, userMessage: ask });
    resend.endedUnbound(failed, false);
    resend.bound("t1", "turn-other", "gen-1");
    expect(resend.hold("gen-1", { ok: false, text: "limit" })).toBe(false);
  });

  it("gives up when the turn's file landed after its end was judged", async () => {
    const rows = [ask, failure];
    const { resend, startTurn, settle, failed } = fixture(rows);
    resend.track({ generation: "gen-1", botId: "helper", threadId: "t1", text: "x", opts: peerOpts, userMessage: ask });
    resend.ended(failed, "gen-1", false);
    resend.hold("gen-1", { ok: false, text: "limit" });
    rows.push({ id: "img", at: LATER, role: "bot", kind: "image", turnId: "turn-1" } as unknown as Message);
    expect(resend.resend("t1")).toBe(true);
    await flush();
    expect(startTurn).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith("gen-1", { ok: false, text: "limit" });
  });
});
