import { describe, expect, it, vi } from "vitest";
import { TurnAuthenticationRefusedError, type RuntimeEvent } from "../contracts.ts";
import { claudeAuthRecovery } from "./claude-auth-recovery.ts";

const message = "Not logged in · Please run /login";
const auth = {
  type: "assistant", error: "authentication_failed", is_api_error_message: true,
  message: { model: "<synthetic>", content: [{ type: "text", text: message }] },
};
const result = { type: "result", is_error: true };
const base = { eventId: "event", provider: "claudeAgent", threadId: "thread", turnId: "turn", createdAt: new Date(0).toISOString() };
const error: RuntimeEvent = { ...base, type: "runtime.error", message, setup: true };
const completed: RuntimeEvent = { ...base, type: "turn.completed", ok: false, stopReason: "auth_required", cost: null };
const work: RuntimeEvent = { ...base, type: "item.started", itemType: "tool", title: "Bash" };

function fixture(retire: () => Promise<boolean> = async () => true) {
  const events: RuntimeEvent[] = [];
  const stopped = vi.fn(retire);
  const recovery = claudeAuthRecovery(event => events.push(event), stopped, () => false);
  const refuse = (before?: () => void) => {
    recovery.frame("thread", { type: "system", subtype: "status" });
    recovery.frame("thread", auth);
    recovery.emit(error);
    before?.();
    recovery.frame("thread", result);
    recovery.emit(completed);
  };
  const send = (play: () => void, startupRecovery = true) => recovery.send({ threadId: "thread", text: "hi", startupRecovery }, async () => {
    recovery.emit({ ...base, type: "turn.started" });
    play();
    return { turnId: "turn" };
  });
  return { recovery, events, stopped, refuse, send };
}

it("waits for retirement before rejecting a synthetic sign-out without publishing a failed turn", async () => {
  let release!: (stopped: boolean) => void;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const sent = f.send(() => f.refuse());
  let settled = false;
  void sent.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.events.map(event => event.type)).toEqual(["turn.started"]);
  release(true);
  await expect(sent).rejects.toMatchObject({ name: "TurnAuthenticationRefusedError", turnId: "turn", message });
  expect(f.stopped).toHaveBeenCalledOnce();
});

it.each([false, "error"])("publishes the original failure when retirement returns %s", async outcome => {
  const f = fixture(async () => { if (outcome === "error") throw new Error("stop failed"); return false; });
  await expect(f.send(() => f.refuse())).resolves.toEqual({ turnId: "turn" });
  expect(f.events).toContainEqual(error);
  expect(f.events).toContainEqual(completed);
});

it("preserves ordinary sign-in handling when recovery is disabled", async () => {
  const f = fixture();
  await expect(f.send(() => f.refuse(), false)).resolves.toEqual({ turnId: "turn" });
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.events).toContainEqual(error);
  expect(f.events).toContainEqual(completed);
});

it.each([
  { type: "assistant", message: { content: [{ type: "text", text: "started work" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
  { type: "stream_event", event: { type: "message_start" } },
  { type: "user", message: { content: [{ type: "tool_result" }] } },
  { type: "system", subtype: "unknown" },
])("does not recover after native activity %#", async frame => {
  const f = fixture();
  await expect(f.send(() => { f.recovery.frame("thread", frame); f.refuse(); })).resolves.toHaveProperty("turnId");
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.events).toContainEqual(error);
});

it("does not recover after a permission request", async () => {
  const f = fixture();
  await expect(f.send(() => {
    f.recovery.emit({ ...base, type: "request.opened", requestType: "permission", requestId: "permission", tool: "Bash", summary: "pwd" });
    f.refuse();
  })).resolves.toHaveProperty("turnId");
  expect(f.stopped).not.toHaveBeenCalled();
});

it.each([
  { ...auth, error: undefined },
  { ...auth, is_api_error_message: false },
  { ...auth, message: { ...auth.message, model: "claude-real" } },
  { ...auth, message: { ...auth.message, content: [null] } },
  { ...auth, message: { ...auth.message, content: [{ type: "tool_use", name: "Bash" }] } },
])("requires the structured synthetic refusal %#", async frame => {
  const f = fixture();
  await expect(f.send(() => {
    f.recovery.frame("thread", frame);
    f.recovery.emit(error);
    f.recovery.frame("thread", result);
    f.recovery.emit(completed);
  })).resolves.toHaveProperty("turnId");
  expect(f.stopped).not.toHaveBeenCalled();
});

it.each([
  { ...result, is_error: false },
  { ...result, total_cost_usd: 0.01 },
])("requires a terminal refusal without new cost %#", async frame => {
  const f = fixture();
  await expect(f.send(() => {
    f.recovery.frame("thread", auth);
    f.recovery.emit(error);
    f.recovery.frame("thread", frame);
    f.recovery.emit(completed);
  })).resolves.toHaveProperty("turnId");
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.events).toContainEqual(error);
});

it("does not recover a stopped turn", async () => {
  const f = fixture();
  await expect(f.send(() => f.refuse(() => {
    f.recovery.emit({ ...completed, stopReason: "interrupted" });
  }))).resolves.toHaveProperty("turnId");
  expect(f.stopped).not.toHaveBeenCalled();
});

it("releases the thread after a refusal so its next turn can run", async () => {
  const f = fixture();
  await expect(f.send(() => f.refuse())).rejects.toBeInstanceOf(TurnAuthenticationRefusedError);
  await expect(f.send(() => f.recovery.emit(work))).resolves.toEqual({ turnId: "turn" });
});

it.each([0.01, 0.02])("compares a retained process's running cost against its prior cost (%s)", async cost => {
  const f = fixture();
  const sent = f.send(() => {
    f.recovery.frame("thread", auth);
    f.recovery.emit(error);
    f.recovery.frame("thread", { ...result, total_cost_usd: cost }, 0.01);
    f.recovery.emit(completed);
  });
  if (cost === 0.01) await expect(sent).rejects.toBeInstanceOf(TurnAuthenticationRefusedError);
  else await expect(sent).resolves.toHaveProperty("turnId");
});

it("matches a multi-block refusal to the error the driver emits for it", async () => {
  const f = fixture();
  const split = { ...auth, message: { ...auth.message, content: [{ type: "text", text: "Not logged in" }, { type: "text", text: " · Please run /login" }] } };
  await expect(f.send(() => {
    f.recovery.frame("thread", split);
    f.recovery.emit(error);
    f.recovery.frame("thread", result);
    f.recovery.emit(completed);
  })).rejects.toBeInstanceOf(TurnAuthenticationRefusedError);
});

describe("a usage-limit refusal", () => {
  const said = "You've hit your 5-hour limit · resets 3:40pm (UTC)";
  const limitFrame = {
    type: "assistant", error: "rate_limit", is_api_error_message: true, api_error: "usage_limit_reached",
    message: { model: "<synthetic>", content: [{ type: "text", text: said }] },
  };
  const limitError: RuntimeEvent = { ...base, type: "runtime.error", message: "This Claude account has reached its 5-hour limit, which resets Oct 19, 3:40 PM (UTC).", limitResetsAt: 1_760_888_400_000 };
  const quota: RuntimeEvent = { ...base, type: "turn.completed", ok: false, stopReason: "quota", cost: null };
  const refuse = (f: ReturnType<typeof fixture>) => {
    f.recovery.frame("thread", { type: "rate_limit_event" });
    f.recovery.frame("thread", limitFrame);
    f.recovery.emit(limitError);
    f.recovery.frame("thread", result);
    f.recovery.emit(quota);
  };

  it("rejects the turn with its reset once the process has stopped, publishing nothing", async () => {
    const f = fixture();
    await expect(f.send(() => refuse(f))).rejects.toMatchObject({
      name: "TurnUsageLimitRefusedError", turnId: "turn", message: limitError.message, resetsAt: 1_760_888_400_000, scope: "engine", known: false,
    });
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(f.events.map(event => event.type)).toEqual(["turn.started"]);
  });

  it("says which limit it was, so one model's own limit holds that model alone", async () => {
    const f = fixture();
    const modelLimit = { ...limitError, limit: "model", limitResetsAt: 1_761_000_000_000 } as RuntimeEvent;
    await expect(f.send(() => {
      f.recovery.frame("thread", { type: "rate_limit_event" });
      f.recovery.frame("thread", limitFrame);
      f.recovery.emit(modelLimit);
      f.recovery.frame("thread", result);
      f.recovery.emit(quota);
    })).rejects.toMatchObject({ name: "TurnUsageLimitRefusedError", resetsAt: 1_761_000_000_000, scope: "model" });
  });

  it("publishes the limit as usual when recovery is off or the model already worked", async () => {
    const off = fixture();
    await expect(off.send(() => refuse(off), false)).resolves.toEqual({ turnId: "turn" });
    expect(off.events).toContainEqual(limitError);
    const worked = fixture();
    await expect(worked.send(() => { worked.recovery.frame("thread", { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } }); refuse(worked); }))
      .resolves.toEqual({ turnId: "turn" });
    expect(worked.stopped).not.toHaveBeenCalled();
    expect(worked.events).toContainEqual(quota);
  });

  it("does not take assistant prose about limits for a refusal", async () => {
    const f = fixture();
    const prose = { ...limitFrame, is_api_error_message: false, error: undefined, api_error: undefined, message: { model: "claude-sonnet-5", content: [{ type: "text", text: said }] } };
    await expect(f.send(() => { f.recovery.frame("thread", prose); f.recovery.emit(limitError); f.recovery.frame("thread", result); f.recovery.emit(quota); }))
      .resolves.toEqual({ turnId: "turn" });
    expect(f.stopped).not.toHaveBeenCalled();
  });
});
