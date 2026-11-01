import { describe, expect, it } from "vitest";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { CoordinateBotsCall } from "../coordinator.ts";
import { createOwnThreadRequests, ownThreadLevel, withRole } from "../host/own-threads.ts";
import type { BotRecord } from "../store.ts";
import { openInternalThread, type ThreadOpenDeps } from "./internal-thread-open.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const gpt: ModelSelection = { instanceId: "codex", model: "gpt-5.5" };
const pam = { id: "pam", name: "Pam", color: "blue", threadId: "pam-chat", modelSelection: sonnet } as unknown as BotRecord;

function setup(over: Partial<ThreadOpenDeps> & { levels?: { opener: ApprovalMode; bot: ApprovalMode }; runs?: (selection: ModelSelection, mode: ApprovalMode) => boolean } = {}) {
  const calls: CoordinateBotsCall[] = [];
  const created: Array<{ threadId: string; approvalMode?: ApprovalMode; modelSelection?: ModelSelection }> = [];
  const started: Array<{ threadId: string; text: string }> = [];
  let opened = 0, next = 0;
  const deps: ThreadOpenDeps = {
    store: {
      bot: (id: string) => id === "pam" ? pam : undefined,
      taskByThread: (_botId: string, threadId: string) => created.some((task) => task.threadId === threadId) || threadId === "pam-chat" ? { title: "Plan" } : undefined,
      createTask: (_botId: string, title?: string, _activate?: boolean, _projectId?: string, _openedBy?: unknown, approvalMode?: ApprovalMode, modelSelection?: ModelSelection) => {
        const task = { threadId: `t${++next}`, title, ...(approvalMode ? { approvalMode } : {}), ...(modelSelection ? { modelSelection } : {}) };
        created.push(task);
        return task;
      },
      appendMessage: () => undefined,
    } as unknown as ThreadOpenDeps["store"],
    from: pam, fromThreadId: "pam-chat", depth: 0, owner: {},
    openedThisTurn: () => opened, countOpened: () => { opened += 1; },
    checkModel: (raw) => ({ ok: true, selection: raw as ModelSelection }),
    givesWay: () => null, modelName: (selection) => selection.model, switchNeedsAsk: () => false, parentModel: () => ({}),
    openerLevel: () => over.levels?.opener ?? "full", botLevel: () => over.levels?.bot ?? "full",
    engineRuns: over.runs ?? (() => true),
    coordinate: async (call) => {
      calls.push(call);
      const threadId = `t${++next}`;
      created.push({ threadId, ...call.ownThread });
      return { status: 200, body: { receipts: [{ threadId, requestId: `as_${next}` }] } };
    },
    startOpened: async (threadId, text) => { started.push({ threadId, text }); return { state: "running" }; },
    language: undefined, limit: 2, requests: createOwnThreadRequests(),
    ...over,
  };
  return { deps, calls, created, started };
}

const open = (deps: ThreadOpenDeps, body: Record<string, unknown>) => openInternalThread(deps, { title: "Review", message: "Review the diff.", ...body });

describe("start_thread on yourself", () => {
  it("starts the thread's work with its role, on report_back and in a plain thread alike", async () => {
    const { deps, calls, started } = setup();
    expect((await open(deps, { reportBack: true, role: "review", modelSelection: gpt })).status).toBe(201);
    expect(calls[0]!.message).toBe("Act as the review helper for this task.\n\nReview the diff.");
    expect((await open(deps, { role: "research" })).status).toBe(201);
    expect(started[0]!.text).toContain("Act as the research helper for this task.\n\nReview the diff.");
    expect((await open(deps, { reportBack: true })).status).toBe(201);
    expect(calls.at(-1)!.message).toBe("Review the diff.");
    expect(await open(deps, { role: "boss" })).toEqual({ status: 400, body: { error: "role must be one of implementation, research, review, design, test, general" } });
  });

  it("returns the thread already opened for the same request_id, from the same conversation only", async () => {
    const { deps, calls, created } = setup();
    const first = await open(deps, { reportBack: true, requestId: "review-gpt", modelSelection: gpt });
    const again = await open(deps, { reportBack: true, requestId: "review-gpt", modelSelection: gpt });
    expect(again).toEqual({ status: 200, body: { ...first.body, existing: true } });
    expect(calls).toHaveLength(1);
    expect(deps.openedThisTurn()).toBe(0);
    const plain = await open(deps, { requestId: "plain-1" });
    expect((await open(deps, { requestId: "plain-1" })).body).toMatchObject({ threadId: plain.body.threadId, existing: true });
    expect(created).toHaveLength(2);
    const elsewhere = await openInternalThread({ ...deps, fromThreadId: "pam-other" }, { title: "Review", message: "Review the diff.", reportBack: true, requestId: "review-gpt" });
    expect(elsewhere.body.existing).toBeUndefined();
    expect(created).toHaveLength(3);
    expect((await open(deps, { requestId: "x".repeat(129) })).body.error).toBe("request_id must be at most 128 characters");
  });

  it("never runs the thread at a broader level than the turn that opened it", async () => {
    const narrowed = setup({ levels: { opener: "ask", bot: "full" } });
    await open(narrowed.deps, { reportBack: true, modelSelection: gpt });
    expect(narrowed.created[0]).toMatchObject({ approvalMode: "ask", modelSelection: gpt });
    await open(narrowed.deps, {});
    expect(narrowed.created[1]).toMatchObject({ approvalMode: "ask" });

    const edits = setup({ levels: { opener: "edits", bot: "full" }, runs: (selection, mode) => mode !== "edits" || selection.instanceId === "claude" });
    await open(edits.deps, { reportBack: true, modelSelection: gpt });
    expect(edits.created[0]).toMatchObject({ approvalMode: "ask" });
    await open(edits.deps, { reportBack: true });
    expect(edits.created[1]).toMatchObject({ approvalMode: "edits" });

    const same = setup({ levels: { opener: "full", bot: "auto" } });
    await open(same.deps, { reportBack: true, modelSelection: gpt });
    expect(same.created[0]!.approvalMode).toBeUndefined();
  });
});

describe("own-thread helpers", () => {
  it("caps a level at the opener's; Custom reads as Auto on either side", () => {
    expect(ownThreadLevel("ask", "full")).toBe("ask");
    expect(ownThreadLevel("auto", "full")).toBe("auto");
    expect(ownThreadLevel("full", "edits")).toBe("edits");
    expect(ownThreadLevel("custom", "full")).toBe("auto");
    expect(ownThreadLevel("custom", "custom")).toBe("custom");
    expect(ownThreadLevel("edits", "custom")).toBe("edits");
    expect(ownThreadLevel("full", "custom")).toBe("custom");
  });

  it("words a role plainly and leaves a message without one as it is", () => {
    expect(withRole("test", "Run the suite.")).toBe("Act as the test helper for this task.\n\nRun the suite.");
    expect(withRole(undefined, "Run the suite.")).toBe("Run the suite.");
  });

  it("forgets a request whose thread is gone", () => {
    const requests = createOwnThreadRequests<{ threadId?: unknown }>();
    requests.remember("pam", "pam-chat", "r1", { threadId: "t1" });
    expect(requests.find("pam", "pam-chat", "r1", () => true)).toEqual({ threadId: "t1" });
    expect(requests.find("pam", "pam-chat", "r1", () => false)).toBeUndefined();
    expect(requests.find("pam", "pam-chat", "r1", () => true)).toBeUndefined();
  });
});
