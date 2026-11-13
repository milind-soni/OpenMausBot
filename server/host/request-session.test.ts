import { describe, expect, it, vi } from "vitest";
import { OUTSIDE } from "../peer-provenance.ts";
import {
  queuedRequestSessionMayDispatch,
  cancelledDirectRequestOutcome,
  cloudHandoffSessionMayResume,
  directTurnRequestMayContinue,
  directTurnRequestContext,
  directTurnRequestSessionMayDispatch,
  quickRetryRequestMayDispatch,
  requestSessionGuard,
  requireLiveBeforeSteerFallback,
  requestSessionOptions,
  settledPrincipalRemainsAuthorized,
  sharedComputerPrincipalForRequest,
  turnOriginForRequest,
} from "./request-session.ts";

describe("request session provenance", () => {
  it("captures only the exact active request generation and session", () => {
    const owner = { generation: "g1", generations: new Set(["g1"]), turnId: null, requestSessionId: "s1" };
    expect(directTurnRequestContext("bot", "g1", owner)).toEqual({ botId: "bot", generation: "g1", requestSessionId: "s1" });
    expect(directTurnRequestContext("bot", "g2", owner)).toBeUndefined();
  });
  it("revalidates after a refused asynchronous steer before fallback", async () => {
    let live = true;
    let release!: (outcome: "refused" | "steered" | "indeterminate") => void;
    const steering = new Promise<"refused" | "steered" | "indeterminate">((resolve) => { release = resolve; });
    const guard = requestSessionGuard("session-a", () => live, () => new Error("revoked"));
    const fallback = vi.fn();
    const dispatch = steering.then((outcome) => {
      requireLiveBeforeSteerFallback(outcome, guard);
      if (outcome === "refused") fallback();
    });
    live = false;
    release("refused");
    await expect(dispatch).rejects.toThrow("revoked");
    expect(fallback).not.toHaveBeenCalled();
    for (const outcome of ["steered", "indeterminate"] as const) {
      expect(() => requireLiveBeforeSteerFallback(outcome, guard)).not.toThrow();
    }
  });

  it("permits a live session's refused-steer fallback", () => {
    const guard = requestSessionGuard("session-a", () => true, () => new Error("revoked"));
    expect(() => requireLiveBeforeSteerFallback("refused", guard)).not.toThrow();
  });

  it("requires the original live session before dispatch and shared-computer principal resolution", () => {
    const live = requestSessionGuard("session-a", (id) => id === "session-a", () => new Error("revoked"));
    expect(live).not.toThrow();
    const revoked = requestSessionGuard("session-a", () => false, () => new Error("revoked"));
    expect(revoked).toThrow("revoked");
    const resolve = vi.fn(() => "owner");
    expect(sharedComputerPrincipalForRequest("session-a", () => false, resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(sharedComputerPrincipalForRequest("session-a", () => true, resolve)).toBe("owner");
  });

  it("rechecks the recorded request session after asynchronous turn preparation and before dispatch", async () => {
    let liveSession = "session-a";
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
    const dispatch = vi.fn();
    const owner = { requestSessionId: "session-a" };
    const preparing = (async () => {
      await preparation;
      if (!directTurnRequestSessionMayDispatch(owner, (id) => id === liveSession)) throw new Error("setup cancelled");
      dispatch();
    })();

    liveSession = "session-b";
    finishPreparation();
    await expect(preparing).rejects.toThrow("setup cancelled");
    expect(dispatch).not.toHaveBeenCalled();
    expect(directTurnRequestSessionMayDispatch(owner, (id) => id === "session-a")).toBe(true);
    expect(directTurnRequestSessionMayDispatch(undefined, () => false)).toBe(true);
  });

  it("keeps delayed work bound to the exact active generation and request session", () => {
    const expected = { botId: "bot-a", generation: "generation-a", requestSessionId: "session-a" };
    const request = { ...expected, generations: new Set(["generation-a"]), turnId: null };
    const mayContinue = (overrides: Partial<typeof request> = {}, live = true, shutdown = false, claim = true) =>
      directTurnRequestMayContinue(expected, "generation-a", { ...request, ...overrides }, () => claim, shutdown, (id) => live && id === "session-a");
    expect(mayContinue()).toBe(true);
    expect(mayContinue({}, false)).toBe(false);
    expect(mayContinue({ requestSessionId: "session-b" })).toBe(false);
    expect(mayContinue({ generation: "generation-b" })).toBe(false);
    expect(mayContinue({ generations: new Set(["generation-b"]) })).toBe(false);
    expect(directTurnRequestMayContinue(expected, "generation-a", { ...request, stopped: true }, () => true, false, () => true)).toBe(false);
    expect(mayContinue({}, true, true)).toBe(false);
    expect(mayContinue({}, true, false, false)).toBe(false);

    const sessionlessRoutine = { ...expected, requestSessionId: undefined, generations: new Set(["generation-a"]), turnId: null };
    expect(directTurnRequestMayContinue({ botId: "bot-a", generation: "generation-a" }, "generation-a", sessionlessRoutine,
      () => true, false, () => false)).toBe(true);
  });

  it("marks only the cancelled generation's accepted user request as settled and cancelled", () => {
    const request = { generation: "generation-a", messageId: "message-a", generations: new Set(["generation-a"]), turnId: null };
    expect(cancelledDirectRequestOutcome(request, "generation-a")).toEqual({
      messageId: "message-a", patch: { requestPending: false, requestCancelled: true },
    });
    expect(cancelledDirectRequestOutcome(request, "generation-b")).toBeUndefined();
    expect(cancelledDirectRequestOutcome({ ...request, messageId: undefined }, "generation-a")).toBeUndefined();
  });

  it("checks a continuation against its recorded effective session, not the current caller", () => {
    const continuationOwner = { requestSessionId: "original-session" };
    expect(directTurnRequestSessionMayDispatch(continuationOwner, (id) => id === "original-session")).toBe(true);
    expect(directTurnRequestSessionMayDispatch(continuationOwner, (id) => id === "new-caller-session")).toBe(false);
  });

  it("authorizes a deferred retry only for its exact live generation and captured session", () => {
    const owner = { botId: "bot-a", generation: "generation-a", requestSessionId: "session-a" };
    const request = { generation: "generation-a", generations: new Set(["generation-a"]), requestSessionId: "session-a", turnId: null };
    const current = (sessionId: string | undefined, generation = "generation-a", live = true) => quickRetryRequestMayDispatch(
      owner, generation, { ...request, requestSessionId: sessionId }, (botId) => botId === "bot-a", (id) => live && id === "session-a",
    );
    expect(current("session-a")).toBe(true);
    expect(current("session-a", "generation-a", false)).toBe(false);
    expect(current("session-b", "generation-b")).toBe(false);
    expect(current("session-a", "generation-b")).toBe(false);
    expect(quickRetryRequestMayDispatch(undefined, "generation-a", request, () => true, () => true)).toBe(false);
    expect(quickRetryRequestMayDispatch({ botId: "bot-a", generation: "generation-a" }, "generation-a",
      { ...request, requestSessionId: undefined }, () => true, () => false)).toBe(true);
    expect(quickRetryRequestMayDispatch(owner, "generation-a", request, () => false, () => true)).toBe(false);
    expect(quickRetryRequestMayDispatch(owner, "generation-a", { ...request, stopped: true }, () => true, () => true)).toBe(false);
  });

  it("requires a live session for Cloud-home lending and restored lending handoffs", () => {
    const resolve = vi.fn(() => "cloud-home");
    expect(sharedComputerPrincipalForRequest(undefined, () => true, resolve, true)).toBeNull();
    expect(sharedComputerPrincipalForRequest(undefined, () => true, resolve, false)).toBe("cloud-home");
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockClear();
    expect(sharedComputerPrincipalForRequest("session-a", () => false, resolve, true)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(sharedComputerPrincipalForRequest("session-a", () => true, resolve, true)).toBe("cloud-home");
    expect(cloudHandoffSessionMayResume(true, true, undefined, () => true)).toBe(false);
    expect(cloudHandoffSessionMayResume(true, true, "session-a", () => false)).toBe(false);
    expect(cloudHandoffSessionMayResume(true, true, "session-a", () => true)).toBe(true);
    expect(cloudHandoffSessionMayResume(false, true, undefined, () => false)).toBe(true);
    expect(cloudHandoffSessionMayResume(true, false, undefined, () => false)).toBe(true);
  });

  it("fails closed for user turns without provenance while allowing explicit system work", () => {
    expect(queuedRequestSessionMayDispatch({ trigger: { kind: "user" } }, () => true)).toBe(false);
    expect(queuedRequestSessionMayDispatch({ trigger: { kind: "owner" } }, () => true)).toBe(false);
    expect(queuedRequestSessionMayDispatch({ trigger: { kind: "routine" } }, () => true)).toBe(true);
    expect(queuedRequestSessionMayDispatch({ requestSessionId: null, trigger: { kind: "user" } }, () => false)).toBe(true);
    expect(queuedRequestSessionMayDispatch({ requestSessionId: "session-a" }, () => true)).toBe(true);
    expect(queuedRequestSessionMayDispatch({ requestSessionId: "session-a" }, () => false)).toBe(false);
  });

  it("inherits provenance only for the same continued message", () => {
    const previous = { messageId: "message-a", requestSessionId: "session-a" };
    expect(requestSessionOptions(undefined, true, previous, "message-a")).toEqual({ requestSessionId: "session-a" });
    expect(requestSessionOptions(undefined, true, previous, "message-b")).toEqual({});
    expect(requestSessionOptions(undefined, true, { messageId: undefined, requestSessionId: "session-a" }, undefined)).toEqual({});
    expect(requestSessionOptions("session-b", true, { messageId: undefined, requestSessionId: "session-a" }, undefined)).toEqual({ requestSessionId: "session-b" });
    expect(requestSessionOptions("session-b", true, previous, "message-a")).toEqual({ requestSessionId: "session-b" });
  });

  it("keeps turn origin bound to the recorded generation and handoff root", () => {
    const owner = { generation: "generation-a", turnId: null, origin: { kind: "user" as const, request: "request-a", person: "person-a" }, generations: new Set(["generation-a"]) };
    const direct = (threadId: string) => threadId === "thread-a" ? owner : undefined;
    const room = (handoffId: string) => handoffId === "handoff-a" ? owner.origin! : OUTSIDE;
    expect(turnOriginForRequest({ threadId: "thread-a", generation: "generation-a" }, direct, room)).toEqual(owner.origin);
    expect(turnOriginForRequest({ threadId: "thread-a", generation: "generation-b" }, direct, room)).toEqual(OUTSIDE);
    expect(turnOriginForRequest({ threadId: "thread-a", generation: "generation-a", externalRuntime: true }, direct, room)).toEqual(OUTSIDE);
    expect(turnOriginForRequest({ threadId: "thread-a", generation: "generation-a", roomHandoffId: "handoff-a" }, direct, room)).toEqual(owner.origin);
  });

  it("rechecks authorization after the wake wait resolves", async () => {
    let authorized = true;
    let release!: (principal: string) => void;
    const wake = new Promise<string>((resolve) => { release = resolve; });
    const checking = settledPrincipalRemainsAuthorized("owner", () => wake, () => authorized);
    authorized = false;
    release("owner");
    await expect(checking).resolves.toBe(false);
    await expect(settledPrincipalRemainsAuthorized("owner", async () => "owner", () => true)).resolves.toBe(true);
  });
});
