import { describe, expect, it } from "vitest";

import { OfficeControl, officeCwdMatches, officeProfileMatches, type OfficeDirectiveRequest, type OfficePrepareInput } from "./office-control.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import type { Assignment } from "./runtime/types.ts";

function fixture() {
  const store = openRuntimeStore(":memory:");
  let now = 1_000_000;
  let generation = "generation-1";
  let assignmentId = "root";
  let nativeModel = "selected-model";
  const row: Assignment = {
    id: "root", rootId: "root", depth: 0, origin: { kind: "person", source: "chat" },
    requester: { kind: "person", threadId: "thread" },
    assignee: { botId: "bot", destination: { kind: "standing_thread", threadId: "thread" } },
    mode: "work", reply: "resume", brief: "PRIVATE PROMPT", status: "running", level: "ask", levelSource: "own",
    executions: 1, restarts: 0, createdAt: now, lastActivityAt: now, result: "", rework: false, version: 1,
    office: { rootDeadline: now + 30_000, attempts: [] },
  };
  store.insert(row, { kind: "enqueued" });
  let request: OfficeDirectiveRequest | undefined;
  const nativeStops: string[] = [];
  const input: OfficePrepareInput = { botId: "bot", threadId: "thread", cwd: "/work/project", instanceId: "selected", driverKind: "codex", model: "selected-model", signal: new AbortController().signal };
  const control = new OfficeControl({
    store, workerId: "hel1", now: () => now,
    resolve: actual => actual.model === nativeModel ? { assignmentId, generation, profileDigest: "a".repeat(64) } : undefined,
    requestDirective: async (value) => { request = value; },
    cancelNative: binding => { nativeStops.push(binding.generation); },
    cancelAssignment: id => {
      const fresh = store.get(id)!; fresh.status = "cancelled"; fresh.finishedAt = now; store.update(fresh);
    },
  });
  const authorize = (decision: "allow" | "deny" = "allow", patch: Record<string, unknown> = {}) => {
    if (!request) throw new Error("missing request");
    const attempt = control.readAttempt(request.attemptId, request.capability)!;
    return control.commitDirective(request.attemptId, request.capability, {
      version: 1, attemptId: attempt.attemptId, generation: attempt.generation, digest: attempt.digest,
      workerId: attempt.workerId, profileDigest: attempt.profileDigest, cwd: attempt.cwd,
      rootDeadline: attempt.rootDeadline, startBefore: attempt.startBefore, kind: attempt.kind, decision,
      controllerHost: "orch-hel1", controllerDecisionId: "12345678-1234-4234-8234-123456789abc", policyVersion: "office-control-v1",
      ...patch,
    });
  };
  return { store, control, input, authorize, nativeStops, request: () => request!, advance: (ms: number) => { now += ms; }, replace: () => { generation = "generation-2"; },
    profileChange: () => { nativeModel = "different-model"; },
    newRoot: () => {
      assignmentId = "new-root"; generation = "new-generation";
      store.insert({ ...row, id: assignmentId, rootId: assignmentId, office: { rootDeadline: row.office!.rootDeadline, attempts: [] } }, { kind: "enqueued" });
    } };
}

describe("native office directives", () => {
  it("requires the exact native task pin rather than a bot default or allowed prefix", () => {
    expect(officeCwdMatches("/shared/project", "/shared/project")).toBe(true);
    expect(officeCwdMatches("/shared/project", "/shared/project/other")).toBe(false);
    expect(officeCwdMatches("/shared/project", "/bot/default")).toBe(false);
    expect(officeCwdMatches(undefined, "/shared/project")).toBe(false);
    expect(officeCwdMatches(null, "/shared/project")).toBe(false);
  });
  it("compares the actual selected model, effort, variant, approval and tools", () => {
    const profile = { instanceId: "codex", model: "selected", effort: "high" as const, approvalMode: "ask" as const, toolScope: { allow: ["native:*"] } };
    expect(officeProfileMatches(profile, profile)).toBe(true);
    for (const actual of [{ ...profile, model: "stale" }, { ...profile, effort: undefined }, { ...profile, variant: "stale" },
      { ...profile, approvalMode: "full" as const }, { ...profile, toolScope: undefined }]) expect(officeProfileMatches(actual, profile)).toBe(false);
  });
  it("matches native tool scopes regardless of allow/deny key order while retaining empty allow semantics", () => {
    const selection = { instanceId: "codex", model: "selected", approvalMode: "ask" as const };
    const actual = { ...selection, toolScope: { allow: ["native:*"], deny: ["native:read"] } };
    const native = { ...selection, toolScope: { deny: ["native:read"], allow: ["native:*"] } };
    expect(officeProfileMatches(actual, native)).toBe(true);
    expect(officeProfileMatches(selection, { ...selection, toolScope: { allow: [] } })).toBe(false);
    expect(officeProfileMatches({ ...selection, toolScope: {} }, { ...selection, toolScope: { allow: [] } })).toBe(false);
  });
  it("requires a durable commit, consumes once, and rejects duplicate commits", async () => {
    const f = fixture();
    await expect(f.control.prepare(f.input)).rejects.toThrow(/directive/);
    const pending = f.control.prepare(f.input);
    expect(f.authorize()).toBe(true);
    expect(f.authorize()).toBe(false);
    const lease = await pending;
    lease.assert("process"); lease.assert("prompt");
    expect(() => lease.assert("process")).toThrow(/consum|start/i);
    expect(() => lease.assert("prompt")).toThrow(/consum|start/i);
    expect(f.control.readAttempt(f.request().attemptId, f.request().capability)?.state).toBe("consumed");
    lease.finish("completed"); f.control.close(); f.store.close();
  });

  it("rejects wrong capabilities, denied directives, and expired start windows", async () => {
    const f = fixture();
    const denied = f.control.prepare(f.input);
    expect(f.control.readAttempt(f.request().attemptId, "wrong")).toBeUndefined();
    f.authorize("deny"); await expect(denied).rejects.toThrow(/denied|directive/);
    const late = f.control.prepare(f.input);
    f.advance(31_000);
    expect(f.authorize()).toBe(false);
    await expect(late).rejects.toThrow(/expired|directive/);
    f.control.close(); f.store.close();
  });

  it("rejects directives for another digest, worker, profile, controller, or deadline", async () => {
    const f = fixture(); const pending = f.control.prepare(f.input);
    for (const patch of [{ digest: "b".repeat(64) }, { workerId: "another-worker" }, { profileDigest: "b".repeat(64) },
      { controllerHost: "another-controller" }, { rootDeadline: 9_999_999 }, { decision: "unknown" }, { extra: "field" }]) {
      expect(f.authorize("allow", patch)).toBe(false);
    }
    expect(f.authorize()).toBe(true);
    const lease = await pending; lease.finish("completed"); f.control.close(); f.store.close();
  });

  it("invalidates before a late grant and detects replacement generations", async () => {
    const f = fixture();
    const stopped = f.control.prepare(f.input);
    f.control.invalidate({ threadId: "thread" }, "Stopped");
    expect(f.authorize()).toBe(false);
    await expect(stopped).rejects.toThrow();
    await expect(f.control.prepare(f.input)).rejects.toThrow(/running native assignment/);
    f.control.close(); f.store.close();
    const replacement = fixture();
    const pending = replacement.control.prepare(replacement.input); replacement.authorize(); const lease = await pending;
    replacement.replace(); expect(() => lease.assert("process")).toThrow(/generation|changed/);
    replacement.control.close(); replacement.store.close();
  });

  it("exposes metadata only and persists hashes rather than capabilities", async () => {
    const f = fixture(); const pending = f.control.prepare(f.input); f.authorize(); const lease = await pending;
    const metadata = JSON.stringify(f.control.readAttempt(f.request().attemptId, f.request().capability));
    expect(metadata).not.toContain("PRIVATE PROMPT");
    expect(metadata).not.toContain(f.request().capability);
    expect(JSON.stringify(f.store.get("root"))).not.toContain(f.request().capability);
    lease.finish("completed"); f.control.close(); f.store.close();
  });

  it("refuses stale actual settings after a controller grant", async () => {
    const f = fixture(); const pending = f.control.prepare(f.input); f.authorize(); const lease = await pending;
    f.profileChange(); expect(() => lease.assert("process")).toThrow(/profile changed/);
    f.control.close(); f.store.close();
  });

  it("quarantines an uncertain earlier root until its exact process stop is confirmed", async () => {
    const f = fixture(); const pending = f.control.prepare(f.input); f.authorize(); const lease = await pending;
    lease.assert("process"); f.control.invalidate({ attemptId: lease.attemptId }, "Stopped"); lease.finish("uncertain");
    expect(f.store.get("root")?.office?.attempts[0]?.state).toBe("uncertain");
    f.newRoot(); await expect(f.control.prepare(f.input)).rejects.toThrow(/earlier native execution is uncertain/);
    expect(f.store.prune(2_000_000)).toBe(0);
    lease.finish("cancelled");
    const retry = f.control.prepare(f.input); f.authorize(); const next = await retry;
    next.finish("completed"); f.control.close(); f.store.close();
  });

  it("preserves an unfinished consumption stamp despite cancelled state until cancellation is confirmed", async () => {
    const f = fixture(); const pending = f.control.prepare(f.input); f.authorize(); const lease = await pending;
    lease.assert("process"); f.control.invalidate({ attemptId: lease.attemptId }, "Stopped");
    const previous = f.store.get("root")!;
    previous.office!.attempts[0]!.state = "cancelled";
    delete previous.office!.attempts[0]!.finishedAt;
    f.store.update(previous);
    f.newRoot(); await expect(f.control.prepare(f.input)).rejects.toThrow(/earlier native execution is uncertain/);
    expect(f.store.prune(2_000_000)).toBe(0);
    lease.finish("cancelled");
    expect(f.store.get("root")?.office?.attempts[0]?.finishedAt).toBeDefined();
    const retry = f.control.prepare(f.input); f.authorize(); const next = await retry;
    next.finish("completed"); f.control.close(); f.store.close();
  });

  it("aborts a consumed native lease on shutdown without cancelling its recoverable assignment", async () => {
    const f = fixture();
    const pending = f.control.prepare(f.input);
    f.authorize();
    const lease = await pending;
    lease.assert("process");
    const before = f.store.get("root")!;
    before.result = "Durable progress before restart";
    f.store.update(before);
    try {
      f.control.close();
      expect(lease.signal.aborted).toBe(true);
      expect(f.nativeStops).toEqual(["generation-1"]);
      expect(f.store.get("root")).toMatchObject({
        status: "running", result: "Durable progress before restart",
        office: { attempts: [{ state: "uncertain", consumedAt: expect.any(Number) }] },
      });
      expect(f.store.get("root")?.outcome).toBeUndefined();
      expect(f.store.get("root")?.finishedAt).toBeUndefined();
      expect(f.store.get("root")?.reportedAt).toBeUndefined();
      expect(f.store.events("root").filter(event => event.kind === "cancelled")).toEqual([]);
      await expect(f.control.prepare(f.input)).rejects.toThrow(/stopped/);
    } finally { f.control.close(); f.store.close(); }
  });
});
