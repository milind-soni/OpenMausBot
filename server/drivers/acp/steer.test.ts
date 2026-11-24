import { describe, expect, it, vi } from "vitest";

import { acpPromptSteering, acpRequestSteering, acpTurnSteering, advertisedCommands, type AcpCommandSteer as AcpSteerSupport } from "./steer.ts";

const support: AcpSteerSupport = {
  command: "steer",
  answer: (chunk) => chunk.startsWith("ok:") ? "accepted" : chunk.startsWith("no:") ? "refused" : null,
};

/** A steering whose sends the test answers by hand. */
function fixture() {
  let running = true;
  const sent: Array<{ text: string; answer: () => void; fail: () => void }> = [];
  const steering = acpTurnSteering(support, () => running, (text) => new Promise<void>((resolve, reject) => {
    sent.push({ text, answer: resolve, fail: () => reject(new Error("rpc error")) });
  }));
  return { steering, sent, stop: () => { running = false; } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("acpTurnSteering", () => {
  it("sends the agent's command with the trimmed text and reports what the agent answered", async () => {
    const { steering, sent } = fixture();
    const outcome = steering.steer("  use pytest\n");
    await tick();
    expect(sent.map((one) => one.text)).toEqual(["/steer use pytest"]);
    expect(steering.swallow("ok: queued")).toBe(true);
    expect(await outcome).toBe("steered");
    sent[0]!.answer();
  });

  it("swallows only an answer, and only while a steer is out", async () => {
    const { steering, sent } = fixture();
    expect(steering.swallow("ok: queued")).toBe(false);
    void steering.steer("x");
    await tick();
    expect(steering.swallow("working on it")).toBe(false);
    expect(steering.swallow("no: busy")).toBe(true);
    sent[0]!.answer();
    await tick();
    expect(steering.swallow("ok: queued")).toBe(false);
  });

  it("reports an answer that comes once the turn can no longer take it as indeterminate", async () => {
    const { steering, stop } = fixture();
    const outcome = steering.steer("x");
    await tick();
    stop();
    steering.swallow("ok: queued");
    expect(await outcome).toBe("indeterminate");
  });

  it("refuses an empty steer, or one once the turn's own prompt is answered, without sending it", async () => {
    const { steering, sent } = fixture();
    expect(await steering.steer("   ")).toBe("refused");
    expect(steering.promptAnswered()).toBeNull();
    expect(await steering.steer("late")).toBe("refused");
    expect(sent).toEqual([]);
  });

  it("holds the answered turn until a steer still out ends, reporting it as indeterminate", async () => {
    const { steering, sent } = fixture();
    const outcome = steering.steer("x");
    await tick();
    const held = steering.promptAnswered();
    expect(held).not.toBeNull();
    expect(await outcome).toBe("indeterminate");
    let ended = false;
    void held!.then(() => { ended = true; });
    await tick();
    expect(ended).toBe(false);
    sent[0]!.answer();
    await tick();
    expect(ended).toBe(true);
  });

  it("refuses a steer the agent answers with an error while the turn runs, and is unsure of one after it", async () => {
    const first = fixture();
    const refused = first.steering.steer("x");
    await tick();
    first.sent[0]!.fail();
    expect(await refused).toBe("refused");

    const second = fixture();
    const unsure = second.steering.steer("x");
    await tick();
    second.stop();
    second.sent[0]!.fail();
    expect(await unsure).toBe("indeterminate");
  });

  it("sends one steer at a time, so each answer belongs to the steer that is out", async () => {
    const { steering, sent } = fixture();
    const first = steering.steer("one");
    const second = steering.steer("two");
    await tick();
    expect(sent.map((one) => one.text)).toEqual(["/steer one"]);
    steering.swallow("no: busy");
    sent[0]!.answer();
    expect(await first).toBe("refused");
    await tick();
    expect(sent.map((one) => one.text)).toEqual(["/steer one", "/steer two"]);
    steering.swallow("ok: queued");
    expect(await second).toBe("steered");
  });
});

describe("advertisedCommands", () => {
  it("reads the names an available_commands_update lists", () => {
    expect(advertisedCommands({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "steer" }, { name: 3 }, null, { name: "queue" }] }))
      .toEqual(new Set(["steer", "queue"]));
    expect(advertisedCommands({ sessionUpdate: "agent_message_chunk" })).toBeNull();
    expect(advertisedCommands({ sessionUpdate: "available_commands_update" })).toBeNull();
    expect(advertisedCommands(null)).toBeNull();
  });
});

describe("acpRequestSteering", () => {
  const rpcError = Object.assign(new Error("unsupported"), { code: -32603 });

  it("steers with the trimmed text when the agent kept it", async () => {
    const sent: string[] = [];
    const steering = acpRequestSteering(() => true, async (text) => { sent.push(text); return { outcome: "steered" }; });
    expect(await steering.steer("  use pytest  ")).toBe("steered");
    expect(sent).toEqual(["use pytest"]);
    expect(steering.promptAnswered()).toBeNull();
  });

  it("refuses promptRequired, a JSON-RPC error, empty text and a turn that is not running, and is unsure after a timeout", async () => {
    expect(await acpRequestSteering(() => true, async () => ({ outcome: "promptRequired" })).steer("x")).toBe("refused");
    expect(await acpRequestSteering(() => true, async () => { throw rpcError; }).steer("x")).toBe("refused");
    expect(await acpRequestSteering(() => true, async () => { throw new Error("session/x timed out"); }).steer("x")).toBe("indeterminate");
    expect(await acpRequestSteering(() => true, async () => ({})).steer("  ")).toBe("refused");
    let sent = false;
    expect(await acpRequestSteering(() => false, async () => { sent = true; return {}; }).steer("x")).toBe("refused");
    expect(sent).toBe(false);
  });
});

describe("acpPromptSteering", () => {
  it("reports a steer as steered once sent, and keeps its reply for the end of the run", async () => {
    let answer: (reply: unknown) => void = () => {};
    const steering = acpPromptSteering(() => true, () => new Promise((resolve) => { answer = resolve; }));
    expect(await steering.steer(" more ")).toBe("steered");
    const ended = steering.promptAnswered();
    expect(ended).not.toBeNull();
    answer({ stopReason: "end_turn" });
    await ended;
    expect(steering.replies).toEqual([{ stopReason: "end_turn" }]);
  });

  it("refuses after the turn's own prompt is answered, and keeps a failed steer's error", async () => {
    const failing = acpPromptSteering(() => true, () => Promise.reject(new Error("boom")));
    expect(await failing.steer("x")).toBe("steered");
    await failing.promptAnswered();
    expect(failing.failure).toBeInstanceOf(Error);
    expect(await failing.steer("late")).toBe("refused");
    expect(await acpPromptSteering(() => false, async () => ({})).steer("x")).toBe("refused");
  });

  describe("taking the turn over", () => {
    const rejected = (error: unknown) => (error as { code?: unknown }).code === -32603;
    /** Steers whose sends the test answers by hand, as the CLI answers the prompt that carried the turn. */
    function takeOver() {
      const sent: Array<{ text: string; answer: (reply: unknown) => void; fail: (error: unknown) => void }> = [];
      const steering = acpPromptSteering(() => true, (text) => new Promise((resolve, reject) => {
        sent.push({ text, answer: resolve, fail: reject });
      }), { rejected });
      return { steering, sent };
    }

    it("takes a steer in once the prompt carrying the turn is answered, then another while that steer carries it", async () => {
      const { steering, sent } = takeOver();
      const first = steering.steer("use pytest");
      await tick();
      const ended = steering.promptAnswered();
      expect(await first).toBe("steered");
      const second = steering.steer("add a README");
      await tick();
      sent[0]!.answer({ stopReason: "end_turn" });
      expect(await second).toBe("steered");
      sent[1]!.answer({ stopReason: "end_turn", usage: { inputTokens: 1 } });
      await ended;
      expect(sent.map((one) => one.text)).toEqual(["use pytest", "add a README"]);
      expect(steering.replies).toEqual([{ stopReason: "end_turn" }, { stopReason: "end_turn", usage: { inputTokens: 1 } }]);
      expect(steering.failure).toBeUndefined();
      expect(await steering.steer("late")).toBe("refused");
    });

    it("refuses a steer the agent rejects before taking it in, without failing the turn", async () => {
      const { steering, sent } = takeOver();
      const outcome = steering.steer("use pytest");
      await tick();
      sent[0]!.fail({ code: -32603, message: "Can't add this prompt" });
      expect(await outcome).toBe("refused");
      expect(steering.promptAnswered()).toBeNull();
      expect(steering.failure).toBeUndefined();
    });

    it("tells the caller, once and without failing the turn, when the agent rejects a steer after the turn's own prompt ended", async () => {
      const { steering, sent } = takeOver();
      const refused = vi.fn();
      const outcome = steering.steer("use pytest", { refused });
      await tick();
      const ended = steering.promptAnswered();
      expect(await outcome).toBe("steered");
      expect(refused).not.toHaveBeenCalled();
      sent[0]!.fail({ code: -32603, message: "Can't add this prompt" });
      await ended;
      expect(refused).toHaveBeenCalledTimes(1);
      expect(steering.failure).toBeUndefined();
    });

    it("keeps any other error of a steer taken in, and the rejection of one whose caller cannot hear it", async () => {
      const { steering, sent } = takeOver();
      const refused = vi.fn();
      const outcome = steering.steer("use pytest", { refused });
      await tick();
      const ended = steering.promptAnswered();
      expect(await outcome).toBe("steered");
      sent[0]!.fail(new Error("socket closed"));
      await ended;
      expect(refused).not.toHaveBeenCalled();
      expect(steering.failure).toEqual(new Error("socket closed"));
    });

    it("keeps the error of a steer that fails after it was taken in", async () => {
      const { steering, sent } = takeOver();
      const outcome = steering.steer("use pytest");
      await tick();
      const ended = steering.promptAnswered();
      expect(await outcome).toBe("steered");
      sent[0]!.fail({ code: -32603, message: "Can't add this prompt" });
      await ended;
      expect(steering.failure).toEqual({ code: -32603, message: "Can't add this prompt" });
    });

    it("waits for the agent however long it takes, refuses a steer it rejects late, and judges the next steer by the turn's own prompt", async () => {
      vi.useFakeTimers();
      try {
        const { steering, sent } = takeOver();
        let first: string | undefined;
        void steering.steer("use pytest").then((outcome) => { first = outcome; });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(first).toBeUndefined();
        sent[0]!.fail({ code: -32603, message: "Can't add this prompt" });
        await vi.advanceTimersByTimeAsync(0);
        expect(first).toBe("refused");
        const second = steering.steer("and a license");
        await vi.advanceTimersByTimeAsync(0);
        expect(steering.promptAnswered()).not.toBeNull();
        expect(await second).toBe("steered");
        sent[1]!.answer({ stopReason: "end_turn" });
        await vi.advanceTimersByTimeAsync(0);
        expect(steering.failure).toBeUndefined();
        expect(steering.replies).toEqual([{ stopReason: "end_turn" }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a steer still out when the turn is stopped before the agent takes it", async () => {
      let live = true;
      const sent: Array<{ answer: (reply: unknown) => void }> = [];
      const steering = acpPromptSteering(() => live, () => new Promise((resolve) => { sent.push({ answer: resolve }); }), { rejected }, () => live);
      const outcome = steering.steer("use pytest");
      await tick();
      live = false;
      sent[0]!.answer({ stopReason: "cancelled" });
      expect(await outcome).toBe("refused");
      const ended = steering.promptAnswered();
      await ended;
      expect(steering.replies).toEqual([{ stopReason: "cancelled" }]);
    });

    it("refuses a steer still out when the turn ends and its requests fail", async () => {
      const { steering, sent } = takeOver();
      const outcome = steering.steer("use pytest");
      await tick();
      sent[0]!.fail(new Error("turn settled"));
      expect(await outcome).toBe("refused");
    });
  });
});
