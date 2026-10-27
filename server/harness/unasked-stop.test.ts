import { describe, expect, it } from "vitest";

import { errorTranscript } from "../../shared/client-cancel.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";
import { unaskedStopMessage, withUnaskedStops } from "./unasked-stop.ts";

function engine() {
  const listeners = new Set<RuntimeEventListener>();
  const interrupted: string[] = [];
  const instance = {
    instanceId: "i1", driverKind: "claude", displayName: "Claude", enabled: true,
    adapter: {
      provider: "claude",
      capabilities: { sessionModelSwitch: "unsupported" as const },
      sendTurn: async () => ({ turnId: "turn-1" }),
      interruptTurn: async (threadId: string) => { interrupted.push(threadId); },
      respondToRequest: async () => "unavailable" as const,
      hasSession: () => false,
      stopAll: async () => {},
      onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
  } as unknown as ProviderInstance;
  const decorated = withUnaskedStops(instance);
  const seen: RuntimeEvent[] = [];
  decorated.adapter.onEvent((event) => seen.push(event));
  const emit = (threadId: string, event: Partial<RuntimeEvent>) => {
    for (const listener of listeners) listener({ eventId: "e", provider: "claude", createdAt: "", threadId, turnId: "turn-1", ...event } as RuntimeEvent);
  };
  const lastError = () => (seen.findLast((event) => event.type === "runtime.error") as { message: string } | undefined)?.message;
  return { decorated, interrupted, emit, lastError };
}

describe("an engine that ends a turn saying only that its request was aborted", () => {
  it("reads as a failure in words when nothing asked it to stop", () => {
    const { emit, lastError } = engine();
    emit("t1", { type: "turn.started" });
    emit("t1", { type: "runtime.error", message: "Request was aborted." });
    expect(lastError()).toBe(unaskedStopMessage("Request was aborted."));
    expect(errorTranscript(lastError()!).kind).toBe("error");
    expect(lastError()).toContain("nobody stopped it");
  });

  it("stays a stop after a Stop, and only for that thread's turn", async () => {
    const { decorated, interrupted, emit, lastError } = engine();
    emit("t1", { type: "turn.started" });
    emit("t2", { type: "turn.started" });
    await decorated.adapter.interruptTurn("t1");
    expect(interrupted).toEqual(["t1"]);
    emit("t1", { type: "runtime.error", message: "This operation was aborted" });
    expect(lastError()).toBe("This operation was aborted");
    emit("t2", { type: "runtime.error", message: "This operation was aborted" });
    expect(lastError()).toBe(unaskedStopMessage("This operation was aborted"));

    emit("t1", { type: "turn.completed", ok: false });
    emit("t1", { type: "turn.started" });
    emit("t1", { type: "runtime.error", message: "context canceled" });
    expect(lastError()).toBe(unaskedStopMessage("context canceled"));
  });

  it("stays a stop for every running turn when the engine is stopped as a whole", async () => {
    const { decorated, emit, lastError } = engine();
    emit("t1", { type: "turn.started" });
    await decorated.adapter.stopAll();
    emit("t1", { type: "runtime.error", message: "provider returned a streaming completion error: The request was cancelled by the client." });
    expect(lastError()).toBe("provider returned a streaming completion error: The request was cancelled by the client.");
    emit("t2", { type: "turn.started" });
    emit("t2", { type: "runtime.error", message: "provider returned a streaming completion error: The request was cancelled by the client." });
    expect(lastError()).toBe(unaskedStopMessage("The request was cancelled by the client."));
  });

  it("leaves every other error as the engine wrote it", () => {
    const { emit, lastError } = engine();
    emit("t1", { type: "turn.started" });
    emit("t1", { type: "runtime.error", message: "API Error: 529 Overloaded" });
    expect(lastError()).toBe("API Error: 529 Overloaded");
    emit("t1", { type: "runtime.error", message: "The request was aborted because the server is restarting." });
    expect(lastError()).toBe("The request was aborted because the server is restarting.");
  });
});
