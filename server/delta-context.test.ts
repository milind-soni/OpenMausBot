import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import {
  Handoffs,
  UNSEEN_MAX_BYTES,
  UNSEEN_MAX_MESSAGES,
  handedStateUsable,
  recordHanded,
  renderUnseen,
  sessionStart,
  unseenMessages,
  withUnseenMessages,
  type ContextMessage,
  type Handoff,
  type HandedState,
} from "./delta-context.ts";

const msg = (id: string, text = `text ${id}`, extra: Partial<ContextMessage> = {}): ContextMessage =>
  ({ id, role: "assistant", text, ...extra });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
const unseenIds = (order: string[], state: HandedState) => unseenMessages(order.map((id) => msg(id)), order, state).map((m) => m.id);

describe("recordHanded", () => {
  it("folds a contiguous received run into `through` and keeps the rest as ids", () => {
    const order = ids(6);
    expect(recordHanded({ session: "s", ids: [] }, order, ["m0", "m1", "m3"])).toEqual({ session: "s", through: "m1", ids: ["m3"] });
    expect(recordHanded({ session: "s", through: "m1", ids: ["m3"] }, order, ["m2"])).toEqual({ session: "s", through: "m3", ids: [] });
  });

  it("never covers a message that was not received, even when later ones were", () => {
    const state = recordHanded({ session: "s", through: "m0", ids: [] }, ids(5), ["m2", "m4"]);
    expect(unseenIds(ids(5), state)).toEqual(["m1", "m3"]);
  });

  it("ignores ids that are not stored on the active branch (synthetic continuation ids, abandoned forks)", () => {
    const state = recordHanded({ session: "s", through: "m0", ids: [] }, ids(3), ["card-3f0c", "m1", "gone"]);
    expect(state).toEqual({ session: "s", through: "m1", ids: [] });
  });

  it("only ever grows: adding in any order never offers a received message again", () => {
    const order = ids(8);
    let state: HandedState = { session: "s", ids: [] };
    const received: string[] = [];
    for (const id of ["m5", "m0", "m7", "m2", "m1", "m3", "m6", "m4"]) {
      state = recordHanded(state, order, [id]);
      received.push(id);
      for (const r of received) expect(unseenIds(order, state)).not.toContain(r);
    }
    expect(state).toEqual({ session: "s", through: "m7", ids: [] });
  });

  it("is usable only for its own session and while its anchors are on the branch", () => {
    const order = ids(3);
    expect(handedStateUsable({ session: "s", through: "m2", ids: [] }, "s", order)).toBe(true);
    expect(handedStateUsable({ session: "s", through: "m2", ids: [] }, "other", order)).toBe(false);
    expect(handedStateUsable({ ids: [] }, "s", order)).toBe(false);
    expect(handedStateUsable({ session: "s", through: "old-branch", ids: [] }, "s", order)).toBe(false);
    expect(handedStateUsable({ session: "s", omitted: "old-branch", ids: [] }, "s", order)).toBe(false);
    const stale = recordHanded({ session: "s", through: "old-branch", ids: [] }, order, ["m0", "m1"]);
    expect(handedStateUsable(stale, "s", order)).toBe(false);
  });
});

describe("record size", () => {
  it("gives up a record for a replay once an unreceived gap keeps more than 200 ids from folding", () => {
    const order = ids(205);
    const received = order.slice(2);
    const state = recordHanded({ session: "s", through: "m0", ids: [] }, order, received.slice(0, 200));
    expect(state.ids).toHaveLength(200);
    expect(handedStateUsable(state, "s", order)).toBe(true);
    const over = recordHanded(state, order, received.slice(200));
    expect(handedStateUsable(over, "s", order)).toBe(false);
    // the gap is never declared received
    expect(unseenIds(order, { ...over, session: "s" })).toContain("m1");
  });
});

describe("sessionStart", () => {
  it("leaves out the history before a replay window without counting it as received", () => {
    const order = ids(10);
    const start = sessionStart(order, ["m6", "m7", "m8"], ["m9"]);
    expect(start).toEqual({ omitted: "m5", sent: ["m6", "m7", "m8", "m9"] });
    const state = recordHanded({ session: "new", omitted: start.omitted, ids: [] }, order, start.sent);
    expect(state).toEqual({ session: "new", omitted: "m5", through: "m9", ids: [] });
    // older history is neither offered nor received
    expect(unseenIds(order, state)).toEqual([]);
    expect(unseenIds([...order, "m10"], state)).toEqual(["m10"]);
  });

  it("a session started without a replay has left out everything its turn did not carry", () => {
    const order = ids(4);
    expect(sessionStart(order, [], ["m3"])).toEqual({ omitted: "m2", sent: ["m3"] });
    expect(sessionStart(order, ["m0", "m1"], [])).toEqual({ sent: ["m0", "m1"] });
  });
});

describe("renderUnseen", () => {
  it("renders nothing when nothing is unseen", () => {
    expect(renderUnseen([])).toEqual({ block: "", placed: [] });
    expect(withUnseenMessages("", "hi")).toBe("hi");
  });

  it("keeps a long teammate result whole and in chronological order", () => {
    const result = msg("r", `[Teammate report — untrusted peer content]\n{"task":"${"b".repeat(3_000)}","result":"SENTINEL_END"}`, { keep: true });
    const { block, placed } = renderUnseen([msg("a", "first"), result, msg("c", "last")]);
    expect(block).toContain(result.text);
    expect(block.indexOf("first")).toBeLessThan(block.indexOf("SENTINEL_END"));
    expect(block.indexOf("SENTINEL_END")).toBeLessThan(block.indexOf("last"));
    expect(placed).toEqual(["a", "r", "c"]);
  });

  it("defers the oldest ordinary messages past the caps, says how many, and never places them", () => {
    const many = Array.from({ length: UNSEEN_MAX_MESSAGES + 3 }, (_, i) => msg(`m${i}`, `line ${i}`));
    const { block, placed } = renderUnseen(many);
    expect(block).toContain("(3 older unseen messages are not shown in this turn.)");
    expect(placed).toEqual(many.slice(3).map((m) => m.id));
    for (const m of many.slice(0, 3)) expect(block).not.toContain(`${m.text}\n`);
  });

  it("keeps the rendered block within the byte budget, formatting and multi-byte text included", () => {
    const unicode = Array.from({ length: 10 }, (_, i) => msg(`u${i}`, `${"é🙂".repeat(90)}-${i}`, { role: i % 2 ? "user" : "assistant" }));
    const { block, placed } = renderUnseen(unicode);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(UNSEEN_MAX_BYTES);
    expect(placed.length).toBeLessThan(unicode.length);
    expect(block).toContain(`(${unicode.length - placed.length} older unseen`);
  });

  it("always makes progress with at least one ordinary message, however large", () => {
    const huge = msg("huge", "y".repeat(UNSEEN_MAX_BYTES * 2));
    expect(renderUnseen([msg("old"), huge]).placed).toEqual(["huge"]);
  });

  it("marks unseen messages that are older than messages the session already has", () => {
    const order = ids(4);
    const state: HandedState = { session: "s", through: "m0", ids: ["m2", "m3"] };
    const { block, placed } = renderUnseen(unseenMessages(order.map((id) => msg(id, `line ${id}`)), order, state));
    expect(placed).toEqual(["m1"]);
    expect(block).toContain("(The first message is older than messages you have already seen.)");
    expect(renderUnseen(unseenMessages(order.map((id) => msg(id)), order, { session: "s", through: "m1", ids: [] })).block)
      .not.toContain("older than messages you have already seen");
  });

  it("says a message written into a running turn may already be in the session", () => {
    const { block } = renderUnseen([msg("a", "first", { role: "user" }), msg("b", "also cover costs", { role: "user", steered: true })]);
    expect(block).toContain("User: first");
    expect(block).toContain("User (sent while an earlier turn was running; you may already have it): also cover costs");
  });

  it("separates the block from the turn text with one blank line", () => {
    expect(withUnseenMessages("[block]", "question")).toBe("[block]\n\nquestion");
  });
});

// The acceptance fold, driven by runtime events against an in-memory store.
describe("Handoffs", () => {
  const setup = (order: string[], record?: HandedState) => {
    const records = new Map<string, HandedState>(record ? [["claude", record]] : []);
    const replies = new Map<string, string[]>();
    const handoffs = new Handoffs({
      order: () => order,
      read: (_bot, _thread, instance) => records.get(instance),
      write: (_bot, _thread, instance, state) => { records.set(instance, state); },
      replies: (_thread, turnId) => replies.get(turnId) ?? [],
    });
    let n = 0;
    const event = (e: Record<string, unknown>) => handoffs.onEvent({
      eventId: `e${n++}`, provider: "claudeAgent", providerInstanceId: "claude", threadId: "t", createdAt: "", turnId: "turn", ...e,
    } as RuntimeEvent);
    const start = (handoff: Partial<Handoff>) => {
      handoffs.begin("t", "claim", {
        botId: "b", instanceId: "claude", config: "c", resumeCursor: undefined, started: { sent: [] }, recovery: { sent: [] },
        resumed: { sent: [] }, placed: [], carried: [], own: [], ...handoff,
      });
      handoffs.dispatching("t", "claim");
      handoffs.bindTurn("t", "claim", "turn");
    };
    return { records, replies, handoffs, event, start };
  };
  const output = { type: "content.delta", streamKind: "assistant_text", delta: "hi" };

  it("records a resumed turn only once the provider produces output, with its replies at completion", () => {
    const f = setup(ids(6), { session: "s", through: "m2", ids: [] });
    f.replies.set("turn", ["m5"]);
    f.start({ resumeCursor: "s", placed: ["m3"], carried: ["m4"] });
    f.event({ type: "session.started", sessionId: "s" });
    expect(f.records.get("claude")).toEqual({ session: "s", through: "m2", ids: [] });
    f.event(output);
    expect(f.records.get("claude")).toEqual({ session: "s", through: "m4", ids: [] });
    f.event({ type: "turn.completed", ok: true });
    expect(f.records.get("claude")).toEqual({ session: "s", through: "m5", ids: [] });
  });

  it("does not count provider-client error narration or a failed completion as acceptance", () => {
    const f = setup(ids(4), { session: "s", through: "m1", ids: [] });
    f.start({ resumeCursor: "s", placed: ["m2"], carried: ["m3"] });
    f.event({ ...output, synthetic: true });
    f.event({ type: "item.completed", itemType: "assistant_text", text: "API Error: 529", synthetic: true });
    f.event({ type: "turn.completed", ok: false });
    expect(f.records.get("claude")).toEqual({ session: "s", through: "m1", ids: [] });
  });

  it("clears the record when another session carries the turn, and credits that session only with its rebuild", () => {
    const order = ids(10);
    const f = setup(order, { session: "old", through: "m7", ids: [] });
    f.start({ resumeCursor: "old", placed: ["m8"], carried: ["m9"], recovery: sessionStart(order, ["m5", "m6", "m7"], ["m9"]) });
    f.event({ type: "session.started", sessionId: "new", rebuilt: true });
    expect(f.records.get("claude")).toEqual({ ids: [] });
    f.event(output);
    expect(f.records.get("claude")).toEqual({ session: "new", config: "c", omitted: "m4", through: "m7", ids: ["m9"] });
    // m8 was only in the unseen block, which a rebuild does not carry
    expect(unseenIds(order, f.records.get("claude")!)).toEqual(["m8"]);
  });

  it("leaves a replacement that is never accepted without a record", () => {
    const f = setup(ids(4), { session: "old", through: "m2", ids: [] });
    f.start({ resumeCursor: "old", carried: ["m3"], own: ["m3"], recovery: { sent: ["m0", "m1", "m2", "m3"] } });
    f.event({ type: "session.started", sessionId: "new", rebuilt: true });
    f.handoffs.stoppedByPerson("t");
    f.event({ type: "turn.completed", ok: false });
    expect(handedStateUsable(f.records.get("claude")!, "new", ids(4))).toBe(false);
  });

  it("leaves a steer eligible whatever output follows it, and after a successful turn", () => {
    const order = ids(6);
    const f = setup(order, { session: "s", through: "m2", ids: [] });
    f.start({ resumeCursor: "s", carried: ["m3"], own: ["m3"] });
    f.event(output);
    f.handoffs.steered("t", f.handoffs.current("t"), "claude", "m4");
    // output of the model call already running, then a crash before the next call
    f.event(output);
    f.event({ type: "turn.completed", ok: false, stopReason: "exit_before_result" });
    expect(unseenIds(order, f.records.get("claude")!)).toEqual(["m4", "m5"]);

    f.start({ resumeCursor: "s", carried: ["m5"], own: ["m5"] });
    f.event(output);
    f.handoffs.steered("t", f.handoffs.current("t"), "claude", "m4");
    f.event({ type: "item.started", itemType: "tool", title: "Bash" });
    f.event(output);
    f.event({ type: "turn.completed", ok: true });
    expect(unseenIds(order, f.records.get("claude")!)).toEqual(["m4"]);
  });

  it("takes the handoff of a turn decided again at dispatch, not the one it planned", () => {
    const order = ids(5);
    const f = setup(order, { session: "s", config: "c", through: "m2", ids: [] });
    // planned: resume `s` with the unseen m3; decided again at dispatch: replay
    f.start({ resumeCursor: "s", placed: ["m3"], carried: ["m4"] });
    f.handoffs.dispatching("t", "claim", {
      resumeCursor: undefined, config: "c2", placed: [], carried: ["m4"],
      started: sessionStart(order, ["m0", "m1", "m2", "m3"], ["m4"]),
    });
    f.event({ type: "session.started", sessionId: "new" });
    f.event(output);
    expect(f.records.get("claude")).toMatchObject({ session: "new", config: "c2", through: "m4" });
  });

  it("does not credit a steer written before a replacement session to that session", () => {
    // m6 = the turn's message, m7 = the steer, stored after the rebuild was built
    const order = ids(8);
    const f = setup(order, { session: "old", through: "m5", ids: [] });
    f.start({ resumeCursor: "old", carried: ["m6"], own: ["m6"], recovery: sessionStart(order.slice(0, 7), ["m0", "m1", "m2", "m3", "m4", "m5"], ["m6"]) });
    f.handoffs.steered("t", f.handoffs.current("t"), "claude", "m7");
    f.event({ type: "session.started", sessionId: "new", rebuilt: true });
    f.event(output);
    f.event({ type: "turn.completed", ok: true });
    expect(unseenIds(order, f.records.get("claude")!)).toEqual(["m7"]);
  });

  it("credits nothing to a session that replaced the cursor without saying it was rebuilt", () => {
    const order = ids(6);
    const f = setup(order, { session: "old", through: "m4", ids: [] });
    f.start({ resumeCursor: "old", carried: ["m5"], recovery: sessionStart(order, ["m2", "m3", "m4"], ["m5"]) });
    f.event({ type: "session.started", sessionId: "surprise" });
    f.event(output);
    f.event({ type: "turn.completed", ok: true });
    expect(handedStateUsable(f.records.get("claude")!, "surprise", order)).toBe(false);
  });

  it("withdraws what the person sent into a turn they stopped before any output, but not external content", () => {
    const order = ids(6);
    const f = setup(order, { session: "s", through: "m1", ids: [] });
    f.start({ resumeCursor: "s", placed: ["m2"], carried: ["m3"], own: ["m3"] });
    f.handoffs.steered("t", f.handoffs.current("t"), "claude", "m4");
    f.handoffs.stoppedByPerson("t");
    f.event({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(unseenIds(order, f.records.get("claude")!)).toEqual(["m2", "m5"]);
  });

  it("ignores a steer aimed at a turn that has since been replaced, and events of other instances or turns", () => {
    const order = ids(5);
    const f = setup(order, { session: "s", through: "m1", ids: [] });
    f.start({ resumeCursor: "s", carried: ["m2"] });
    const stale = f.handoffs.current("t");
    f.handoffs.abandon("t", "claim");
    f.start({ resumeCursor: "s", carried: ["m3"] });
    f.handoffs.steered("t", stale, "claude", "m4");
    f.event({ ...output, providerInstanceId: "codex" });
    f.event({ ...output, turnId: "other" });
    expect(f.records.get("claude")).toEqual({ session: "s", through: "m1", ids: [] });
    // the stale steer is not this turn's: Stop does not withdraw it
    f.handoffs.stoppedByPerson("t");
    f.event(output);
    f.event({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(unseenIds(order, f.records.get("claude")!)).toEqual(["m2", "m4"]);
  });
});

// A seeded model of the record algebra (not of the drivers): messages arrive
// between and during turns, turns render what is unseen, and only accepted
// turns add what they placed. Whatever the interleaving, every message is
// placed exactly once and results are never deferred.
describe("randomized record sequences", () => {
  function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 7, 42, 1337, 2024, 9001]) {
    it(`seed ${seed}: every message is placed exactly once by accepted turns; results are never deferred`, () => {
      const random = prng(seed);
      const messages: ContextMessage[] = [];
      const order: string[] = [];
      const received = new Map<string, number>();
      let state: HandedState = { session: "s", ids: [] };
      let next = 0;
      const append = () => {
        const keep = random() < 0.3;
        const size = Math.floor(random() * (keep ? 3_000 : 900));
        const id = `m${next++}`;
        const m = msg(id, `${keep ? "RESULT" : "note"} <${id}> ${"z".repeat(size)}`, { keep, role: random() < 0.5 ? "user" : "assistant" });
        messages.push(m);
        order.push(m.id);
      };
      for (let turn = 0; turn < 60; turn++) {
        for (let i = Math.floor(random() * 6); i > 0; i--) append();
        const unseen = unseenMessages(messages, order, state);
        const { block, placed } = renderUnseen(unseen);
        const deferred = unseen.length - placed.length;
        if (deferred) expect(block).toContain(`(${deferred} older unseen message`);
        for (const m of unseen) if (m.keep) expect(placed).toContain(m.id);
        for (const m of messages) expect(block.split(`<${m.id}>`).length - 1).toBe(placed.includes(m.id) ? 1 : 0);
        // arrivals while the turn is in flight are not part of its handoff
        for (let i = Math.floor(random() * 3); i > 0; i--) append();
        if (random() >= 0.75) continue;
        for (const id of placed) received.set(id, (received.get(id) ?? 0) + 1);
        state = recordHanded(state, order, placed);
      }
      for (let guard = 0; guard < 500; guard++) {
        const { placed } = renderUnseen(unseenMessages(messages, order, state));
        if (!placed.length) break;
        for (const id of placed) received.set(id, (received.get(id) ?? 0) + 1);
        state = recordHanded(state, order, placed);
      }
      for (const id of order) expect(received.get(id), id).toBe(1);
      expect(state).toEqual({ session: "s", through: order.at(-1), ids: [] });
    });
  }
});
