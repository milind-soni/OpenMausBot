import { describe, expect, it, vi } from "vitest";
import { OUTSIDE } from "../peer-provenance.ts";
import {
  queuedRequestSessionMayDispatch,
  requestSessionGuard,
  requireLiveBeforeSteerFallback,
  requestSessionOptions,
  settledPrincipalRemainsAuthorized,
  sharedComputerPrincipalForRequest,
  turnOriginForRequest,
} from "./request-session.ts";

describe("request session provenance", () => {
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
