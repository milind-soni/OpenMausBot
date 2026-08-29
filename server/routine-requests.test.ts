import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RoutineRequestError,
  RoutineRequestService,
  routineRequestFingerprint,
  type RoutineProposalInput,
  type RoutineRequestMessage,
  type RoutineRequestOptionCard,
  type RoutineRequestStore,
  type RoutineToolDefinitionInput,
} from "./routine-requests.ts";
import { RoutineManager } from "./routines.ts";
import type { JsonValue } from "./schema.ts";

class MemoryStore implements RoutineRequestStore {
  readonly threads = new Map<string, RoutineRequestMessage[]>();
  private sequence = 0;

  messagesFor(threadId: string): RoutineRequestMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: RoutineRequestOptionCard },
  ): RoutineRequestMessage {
    const stored = { id: `message-${++this.sequence}`, card: message.card };
    const messages = this.threads.get(threadId) ?? [];
    messages.push(stored);
    this.threads.set(threadId, messages);
    return stored;
  }

  patchMessage(
    threadId: string,
    messageId: string,
    patch: { card: RoutineRequestOptionCard },
  ): RoutineRequestMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(
  start = Date.parse("2026-08-28T10:00:00Z"),
  cloudReady?: () => Promise<{ ready: boolean; reason?: string }>,
  canPersist?: (
    botId: string,
    threadId: string,
  ) => { ok: true } | { ok: false; status: number; error: string },
) {
  const clock = { now: start };
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-request-"));
  tempDirs.push(dir);
  const routines = new RoutineManager({
    file: join(dir, "routines.json"),
    now: () => clock.now,
    botState: (botId) => (botId === "missing" ? "missing" : "busy"),
    createTask: () => null,
    startTurn: async () => {},
  });
  const store = new MemoryStore();
  const service = new RoutineRequestService({
    store,
    routines,
    now: () => clock.now,
    timeZone: () => "Asia/Kolkata",
    cloudReady,
    canPersist,
  });
  return { clock, routines, service, store };
}

function createProposal(overrides: Partial<RoutineToolDefinitionInput> = {}): RoutineProposalInput {
  return {
    action: "create",
    routine: {
      name: "Morning brief",
      instructions: "Summarize the overnight support queue.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "wednesday"] },
      ...overrides,
    },
  };
}

function malformedProposal(value: JsonValue): RoutineProposalInput {
  // SAFETY: These values are deliberately malformed to exercise the runtime
  // Zod boundary; production callers receive the schema-derived type.
  return value as RoutineProposalInput;
}

function cardFingerprint(card: RoutineRequestOptionCard, messageId: string): string {
  if (!card.routineRequest) throw new Error("missing routine request payload");
  return routineRequestFingerprint(card.routineRequest, messageId);
}

describe("RoutineRequestService", () => {
  it("normalizes weekly input, scrubs hidden payload text, and creates a durable confirmation card", async () => {
    const { service, store, routines } = harness();
    const secret = "sk-proj-abcdefghijklmnopqrstuv";
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ instructions: `Use ${secret} to prepare the brief.` }),
    });

    expect(routines.listRoutines()).toHaveLength(0);
    expect(proposed.timeZone).toBe("Asia/Kolkata");
    expect(proposed.summary).toContain("Monday, Wednesday at 09:00 (Asia/Kolkata)");
    const card = store.messagesFor("thread-a")[0]!.card!;
    expect(card.requestId).toBe(proposed.requestId);
    expect(card.tool).toBe("schedule_routine");
    expect(card.options).toEqual(["Confirm", "Cancel"]);
    expect(card.routineRequest?.operation).toMatchObject({
      action: "create",
      routine: { schedule: { type: "daily", time: "09:00", weekdays: [1, 3] } },
    });
    expect(JSON.stringify(card)).not.toContain(secret);
    expect(JSON.stringify(card)).toContain("redacted");
  });

  it("canonicalizes receipt fingerprints and binds them to the card's conversation", async () => {
    const { service, store } = harness();
    await service.propose({ botId: "bot-a", threadId: "thread-a", proposal: createProposal() });
    const messageId = store.messagesFor("thread-a")[0]!.id;
    const original = store.messagesFor("thread-a")[0]!.card!.routineRequest!;
    if (original.operation.action !== "create") throw new Error("Expected a create proposal");
    const routine = original.operation.routine;
    const reordered: typeof original = {
      operation: {
        routine: {
          durationMinutes: routine.durationMinutes,
          schedule: routine.schedule.type === "once"
            ? { at: routine.schedule.at, type: "once" }
            : { weekdays: [...routine.schedule.weekdays], time: routine.schedule.time, type: "daily" },
          instructions: routine.instructions,
          runOn: routine.runOn,
          name: routine.name,
        },
        action: "create",
      },
      createdAt: original.createdAt,
      threadId: original.threadId,
      botId: original.botId,
      requestId: original.requestId,
      version: 1,
    };

    expect(routineRequestFingerprint(reordered, messageId)).toBe(routineRequestFingerprint(original, messageId));
    expect(routineRequestFingerprint({ ...reordered, threadId: "thread-b" }, messageId))
      .not.toBe(routineRequestFingerprint(original, messageId));
    expect(routineRequestFingerprint(reordered, "another-message"))
      .not.toBe(routineRequestFingerprint(original, messageId));
  });

  it("shows the exact action, name, and complete executable instructions in the approval detail", async () => {
    const { service, store } = harness();
    const instructions = `BEGIN-${"work carefully. ".repeat(120)}-END`;
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ name: "Full fidelity brief", instructions }),
    });
    const message = store.messagesFor("thread-a")[0]!;
    const card = message.card!;
    card.held = "Temporary persistence error";

    expect(proposed.summary).toContain("Schedule “Full fidelity brief”");
    expect(proposed.summary).not.toContain(instructions);
    expect(proposed.detail).toBe(card.subtitle);
    expect(card.subtitle).toContain("Action: Create routine");
    expect(card.subtitle).toContain("Name: Full fidelity brief");
    expect(card.subtitle).toContain(`Instructions:\n${instructions}`);
    expect(card.subtitle).toContain("-END");
  });

  it("never returns an existing routine's credential-shaped text to the proposing bot", async () => {
    const { service, routines, store } = harness();
    const secret = "sk-proj-existingroutineabcdefghijkl";
    const nameSecret = "sk-proj-existingnameabcdefghijkl";
    const routine = routines.create({
      botId: "bot-a",
      name: `Existing ${nameSecret}`,
      prompt: `Use ${secret} and then prepare the brief.`,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "run_now", routineId: routine.id },
    });

    expect(proposed.detail).not.toContain(secret);
    expect(proposed.title).not.toContain(nameSecret);
    expect(proposed.summary).not.toContain(nameSecret);
    expect(proposed.detail).not.toContain(nameSecret);
    expect(proposed.detail).toContain("redacted");
    expect(JSON.stringify(store.messagesFor("thread-a")[0]!.card)).not.toContain(secret);
    expect(JSON.stringify(store.messagesFor("thread-a")[0]!.card)).not.toContain(nameSecret);
  });

  it("rejects ambiguous, invalid, and stale one-time schedules", async () => {
    const { service, clock } = harness();
    const proposal = (at: string) =>
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: createProposal({ schedule: { type: "once", at } }),
      });

    await expect(proposal("2026-08-29T09:00:00")).rejects.toThrow(/explicit timezone offset/);
    await expect(proposal("not-a-date")).rejects.toThrow(/explicit timezone offset/);
    await expect(proposal("2026-02-30T09:00:00Z")).rejects.toThrow(/valid RFC3339/);
    await expect(proposal(new Date(clock.now - 1).toISOString())).rejects.toThrow(/future/);
    await expect(
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: createProposal({ durationMinutes: 5 }),
      }),
    ).rejects.toThrow(/15 to 240/);
    await expect(
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: malformedProposal({
          action: "create",
          routine: {
            name: "Morning brief",
            instructions: "Do it",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            surprise: true,
          },
        }),
      }),
    ).rejects.toThrow(/Unrecognized key.*surprise/);
    await expect(
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: malformedProposal({
          action: "create",
          routine: {
            name: "Morning brief",
            instructions: "Do it",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"], timezone: "UTC" },
          },
        }),
      }),
    ).rejects.toThrow(/Unrecognized key.*timezone/);
    await expect(
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: createProposal({ name: `${"n".repeat(64)} token=abcdefgh` }),
      }),
    ).rejects.toThrow(/80 characters or fewer after credentials are removed/);
    const secretPrefix = "token=abcdefgh ";
    const secretAtLimit = `${secretPrefix}${"x".repeat(20_000 - secretPrefix.length)}`;
    await expect(
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: createProposal({ instructions: secretAtLimit }),
      }),
    ).rejects.toThrow(/20,000 characters or fewer after credentials are removed/);
  });

  it("refuses a cloud routine before creating a card when cloud execution is not ready", async () => {
    const { service, store } = harness(undefined, async () => ({
      ready: false,
      reason: "Connect or provision a cloud computer first.",
    }));

    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ runOn: "cloud" }),
    })).rejects.toThrow(/Connect or provision/);
    expect(store.messagesFor("thread-a")).toHaveLength(0);
  });

  it("checks effective cloud destinations while allowing safe moves away and non-running actions", async () => {
    let checks = 0;
    const { service, routines, store } = harness(undefined, async () => {
      checks += 1;
      return { ready: false, reason: "Cloud is offline" };
    });
    const routine = routines.create({
      botId: "bot-a",
      name: "Cloud routine",
      prompt: "Use the cloud computer",
      runOn: "cloud",
      enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });

    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "Still cloud" } },
    })).rejects.toThrow(/Cloud is offline/);
    expect(checks).toBe(1);

    await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { runOn: "maus" } },
    });
    await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "pause", routineId: routine.id },
    });
    await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "delete", routineId: routine.id },
    });
    expect(checks).toBe(1);
    expect(store.messagesFor("thread-a")).toHaveLength(3);
  });

  it("does not persist a stale card when a routine changes during cloud readiness", async () => {
    let mutateDuringCheck = () => {};
    const { service, routines, store } = harness(undefined, async () => {
      mutateDuringCheck();
      return { ready: true };
    });
    const routine = routines.create({
      botId: "bot-a",
      name: "Cloud routine",
      prompt: "Original instructions",
      runOn: "cloud",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    mutateDuringCheck = () => {
      routines.update(routine.id, { prompt: "Changed while checking Cloud" });
    };

    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "run_now", routineId: routine.id },
    })).rejects.toThrow(/changed after this confirmation card/);
    expect(store.messagesFor("thread-a")).toHaveLength(0);
  });

  it("revalidates conversation ownership after an asynchronous cloud check", async () => {
    let finishCloudCheck!: (value: { ready: boolean }) => void;
    const cloudCheck = new Promise<{ ready: boolean }>((resolve) => {
      finishCloudCheck = resolve;
    });
    let ownsConversation = true;
    const { service, store } = harness(
      undefined,
      () => cloudCheck,
      () => ownsConversation
        ? { ok: true }
        : { ok: false, status: 403, error: "source conversation does not belong to sender" },
    );

    const proposal = service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ runOn: "cloud" }),
    });
    ownsConversation = false;
    finishCloudCheck({ ready: true });

    await expect(proposal).rejects.toMatchObject({ status: 403 });
    expect(store.messagesFor("thread-a")).toHaveLength(0);
  });

  it("denies without changing the scheduler and claims duplicate answers", async () => {
    const { service, routines, store } = harness();
    const proposal = await service.propose({ botId: "bot-a", threadId: "thread-a", proposal: createProposal() });

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "answer",
    })).toMatchObject({ claimed: true, state: "invalid" });
    expect(store.messagesFor("thread-a")[0]!.card!.answered).toBeUndefined();

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "deny",
    })).toEqual({ claimed: true, state: "denied" });
    expect(routines.listRoutines()).toHaveLength(0);
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    })).toEqual({ claimed: true, state: "already_settled", behavior: "deny" });
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: "provider-request",
      behavior: "allow",
    })).toEqual({ claimed: false, state: "not_found" });
  });

  it("creates only after confirmation, pins ownership, and is durable-idempotent", async () => {
    const { service, routines, store, clock } = harness();
    const proposal = await service.propose({ botId: "bot-a", threadId: "thread-a", proposal: createProposal() });

    // Model a crash after routines.json was atomically written but before the
    // transcript card was settled.
    const message = store.messagesFor("thread-a")[0]!;
    const card = message.card!;
    const committed = routines.create({
      botId: "bot-a",
      name: "Morning brief",
      prompt: "Summarize the overnight support queue.",
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 3] },
      durationMinutes: 30,
    }, {
      requestId: proposal.requestId,
      messageId: message.id,
      botId: "bot-a",
      threadId: "thread-a",
      action: "create",
      fingerprintVersion: 1,
      fingerprint: cardFingerprint(card, message.id),
    });
    const receipt = routines.routineRequestReceipt(proposal.requestId);
    expect(receipt?.resultId).toBe(committed.id);
    clock.now += 60_000;

    const first = service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    });
    expect(first).toMatchObject({ claimed: true, state: "applied", action: "create" });
    if (first.state !== "applied") throw new Error("Expected the routine to be applied");
    expect(routines.listRoutines()).toMatchObject([{ botId: "bot-a", name: "Morning brief", enabled: true }]);
    expect(routines.routineRequestReceipt(proposal.requestId)).toBeNull();
    expect(store.messagesFor("thread-a")[0]!.card).toMatchObject({
      held: undefined,
      routineRequest: { appliedAt: receipt?.appliedAt },
    });

    // Once the durable card is settled, duplicate clicks are claimed by the
    // card itself and the compact recovery receipt can be removed.
    const second = service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    });
    expect(second).toMatchObject({ claimed: true, state: "already_settled", behavior: "allow" });
    expect(routines.listRoutines()).toHaveLength(1);

    expect(service.resolve({
      botId: "bot-b",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 403 });
  });

  it("applies update, pause, resume, run-now, and delete only to the owning bot", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Old name",
      prompt: "Old instructions",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
      durationMinutes: 30,
    });

    await expect(service.propose({
      botId: "bot-b",
      threadId: "thread-b",
      proposal: { action: "pause", routineId: routine.id },
    })).rejects.toThrow(RoutineRequestError);

    const apply = async (proposal: RoutineProposalInput) => {
      const card = await service.propose({ botId: "bot-a", threadId: "thread-a", proposal });
      const result = service.resolve({
        botId: "bot-a",
        threadId: "thread-a",
        requestId: card.requestId,
        behavior: "allow",
      });
      expect(result.state).toBe("applied");
      return { card, result };
    };

    await apply({
      action: "update",
      routineId: routine.id,
      changes: { name: "New name", instructions: "New instructions", durationMinutes: 45 },
    });
    expect(routines.listRoutines()[0]).toMatchObject({
      name: "New name",
      prompt: "New instructions",
      durationMinutes: 45,
    });

    await apply({ action: "pause", routineId: routine.id });
    expect(routines.listRoutines()[0]!.enabled).toBe(false);
    await apply({ action: "resume", routineId: routine.id });
    expect(routines.listRoutines()[0]!.enabled).toBe(true);

    const runNow = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "run_now", routineId: routine.id },
    });
    const runMessage = store.messagesFor("thread-a").find(
      (message) => message.card?.requestId === runNow.requestId,
    )!;
    const runCard = runMessage.card!;
    routines.runNow(routine.id, {
      requestId: runNow.requestId,
      messageId: runMessage.id,
      botId: "bot-a",
      threadId: "thread-a",
      action: "run_now",
      fingerprintVersion: 1,
      fingerprint: cardFingerprint(runCard, runMessage.id),
    });
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: runNow.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "applied" });
    expect(routines.listRuns()).toHaveLength(1);
    expect(routines.routineRequestReceipt(runNow.requestId)).toBeNull();
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: runNow.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "already_settled" });
    expect(routines.listRuns()).toHaveLength(1);

    await apply({ action: "delete", routineId: routine.id });
    expect(routines.listRoutines()).toHaveLength(0);
  });

  it("captures and enforces the routine revision for every manage confirmation", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Mutable routine",
      prompt: "Original instructions",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "pause", routineId: routine.id },
    });
    expect(store.messagesFor("thread-a")[0]!.card?.routineRequest?.operation).toMatchObject({
      action: "pause",
      expectedUpdatedAt: routine.updatedAt,
    });

    const changed = routines.update(routine.id, { name: "Changed elsewhere" })!;
    expect(changed.updatedAt).toBeGreaterThan(routine.updatedAt);
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(routines.listRoutines()[0]).toMatchObject({ name: "Changed elsewhere", enabled: true });
    expect(store.messagesFor("thread-a")[0]!.card?.held).toMatch(/changed after this confirmation card/);
  });

  it("settles manage cards whose requested mutation already committed before a crash", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Before",
      prompt: "Original instructions",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const update = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "After" } },
    });

    // Model a crash after routines.json was atomically written but before the
    // transcript card was settled. A retry recognizes the exact end state.
    const updateMessage = store.messagesFor("thread-a")[0]!;
    const updateCard = updateMessage.card!;
    const committed = routines.update(routine.id, { name: "After" }, {
      requestId: update.requestId,
      messageId: updateMessage.id,
      botId: "bot-a",
      threadId: "thread-a",
      action: "update",
      fingerprintVersion: 1,
      fingerprint: cardFingerprint(updateCard, updateMessage.id),
    })!;
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: update.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "applied", resultId: routine.id });
    expect(routines.listRoutines()[0]!.updatedAt).toBe(committed.updatedAt);
    expect(store.messagesFor("thread-a")[0]!.card?.answered).toBe("allow");
    expect(routines.routineRequestReceipt(update.requestId)).toBeNull();

    const deletion = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "delete", routineId: routine.id },
    });
    const deleteMessage = store.messagesFor("thread-a")[1]!;
    const deleteCard = deleteMessage.card!;
    routines.remove(routine.id, {
      requestId: deletion.requestId,
      messageId: deleteMessage.id,
      botId: "bot-a",
      threadId: "thread-a",
      action: "delete",
      fingerprintVersion: 1,
      fingerprint: cardFingerprint(deleteCard, deleteMessage.id),
    });
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: deletion.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "applied", resultId: routine.id });
    expect(store.messagesFor("thread-a")[1]!.card?.answered).toBe("allow");
    expect(routines.routineRequestReceipt(deletion.requestId)).toBeNull();
  });

  it("never mistakes an unrelated matching state for the card's committed operation", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Before",
      prompt: "Safe instructions",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const proposal = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "Reviewed" } },
    });

    routines.update(routine.id, { name: "Reviewed", prompt: "Unrelated changed instructions" });
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(store.messagesFor("thread-a")[0]!.card?.answered).toBeUndefined();
  });

  it("rejects a malformed persisted action instead of falling through to delete", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Keep me",
      prompt: "Never delete on malformed input",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "delete", routineId: routine.id },
    });
    const message = store.messagesFor("thread-a")[0]!;
    const card = message.card!;
    Object.assign(card.routineRequest!.operation, { action: "destroy" });

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 400 });
    expect(routines.listRoutines()).toMatchObject([{ id: routine.id, name: "Keep me" }]);
    expect(card.answered).toBeUndefined();

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "deny",
    })).toEqual({ claimed: true, state: "denied" });
    expect(store.messagesFor("thread-a")[0]!.card?.answered).toBe("deny");
  });

  it("reports an already-committed malformed card as applied instead of cancelled", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Before",
      prompt: "Keep the result truthful",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "After" } },
    });
    const message = store.messagesFor("thread-a")[0]!;
    const card = message.card!;
    routines.update(routine.id, { name: "After" }, {
      requestId: proposed.requestId,
      messageId: message.id,
      botId: "bot-a",
      threadId: "thread-a",
      action: "update",
      fingerprintVersion: 1,
      fingerprint: cardFingerprint(card, message.id),
    });
    Object.assign(card.routineRequest!.operation, { action: "future_schema_action" });

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "deny",
    })).toMatchObject({ claimed: true, state: "applied", action: "update", resultId: routine.id });
    expect(store.messagesFor("thread-a")[0]!.card?.answered).toBe("allow");
    expect(routines.listRoutines()[0]!.name).toBe("After");
    expect(routines.routineRequestReceipt(proposed.requestId)).toBeNull();
  });

  it("lets Cancel close a semantically corrupted card when no action committed", async () => {
    const { service, routines, store } = harness();
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal(),
    });
    const card = store.messagesFor("thread-a")[0]!.card!;
    card.routineRequest!.requestId = "nested-wrong-id";

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "deny",
    })).toEqual({ claimed: true, state: "denied" });
    expect(store.messagesFor("thread-a")[0]!.card?.answered).toBe("deny");
    expect(routines.listRoutines()).toHaveLength(0);
  });

  it("shows no next run when an update leaves a paused routine paused", async () => {
    const { service, routines, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "Paused routine",
      prompt: "Stay paused",
      enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "Still paused" } },
    });

    expect(proposed.nextRunAt).toBeNull();
    expect(proposed.summary).toContain("Remains paused");
    const card = store.messagesFor("thread-a")[0]!.card!;
    expect(card.subtitle).toContain("Action: Update routine");
    expect(card.subtitle).toContain("Name: Still paused");
    expect(card.subtitle).toContain("Next run: None — this routine remains paused");
    expect(card.subtitle).toContain("Instructions:\nStay paused");
  });

  it("refuses a one-time update that became stale while awaiting confirmation", async () => {
    const { service, routines, clock, store } = harness();
    const routine = routines.create({
      botId: "bot-a",
      name: "One time",
      prompt: "Do it",
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    });
    const scheduledAt = clock.now + 60_000;
    const proposal = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: {
        action: "update",
        routineId: routine.id,
        changes: { schedule: { type: "once", at: new Date(scheduledAt).toISOString() } },
      },
    });
    clock.now = scheduledAt + 1;

    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(routines.listRoutines()[0]!.schedule.type).toBe("daily");
    expect(store.messagesFor("thread-a")[0]!.card?.held).toMatch(/now in the past/);
  });

  it("never resumes a one-time routine with no future occurrence", async () => {
    const { service, routines, clock } = harness();
    const future = clock.now + 60_000;
    const routine = routines.create({
      botId: "bot-a",
      name: "One time",
      prompt: "Do it",
      enabled: false,
      schedule: { type: "once", at: future },
    });
    const proposal = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "resume", routineId: routine.id },
    });
    clock.now = future + 1;
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposal.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    expect(routines.listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });

    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "resume", routineId: routine.id },
    })).rejects.toThrow(/new future time/);
  });
});
