import { describe, expect, it } from "vitest";

import { acpTurnSteering, advertisedCommands, type AcpSteerSupport } from "./steer.ts";

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
