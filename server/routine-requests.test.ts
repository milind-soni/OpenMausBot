import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RoutineRequestError,
  RoutineRequestService,
  consequenceLine,
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

  it("carries continuity from the proposal through the card to the created routine", async () => {
    const { service, store, routines } = harness();

    const plain = await service.propose({
      botId: "bot-a",
      threadId: "thread-plain",
      proposal: createProposal(),
    });
    expect(plain.detail).toContain("Continuity: Each run starts fresh");

    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ continuity: true }),
    });
    expect(proposed.detail).toContain("Continuity: Carries the previous run's report into the next run");

    const card = store.messagesFor("thread-a")[0]!.card!;
    expect(card.routineRequest?.operation).toMatchObject({
      action: "create",
      routine: { continuity: true },
    });

    const result = service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    });
    expect(result.state).toBe("applied");
    expect(routines.listRoutines().find((routine) => routine.name === "Morning brief")?.continuity).toBe(true);
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
            : routine.schedule.type === "interval"
              ? {
                  anchorAt: routine.schedule.anchorAt,
                  everyMinutes: routine.schedule.everyMinutes,
                  type: "interval",
                }
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

  it("states the run cadence consequence before Instructions for an interval routine", async () => {
    const { service, store } = harness();
    await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ schedule: { type: "interval", everyMinutes: 5 } }),
    });
    const card = store.messagesFor("thread-a")[0]!.card!;

    expect(card.subtitle).toContain(
      "Will run about 288 times a day; each run starts a fresh session.\n\nInstructions:",
    );
  });

  it("states the run cadence consequence for a weekday routine", async () => {
    const { service, store } = harness();
    await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({
        schedule: {
          type: "weekly",
          time: "09:00",
          weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        },
      }),
    });
    const card = store.messagesFor("thread-a")[0]!.card!;

    expect(card.subtitle).toContain(
      "Will run 5 days a week; each run starts a fresh session.\n\nInstructions:",
    );
  });

  it("states every day for a full-week routine and once for a one-time routine", async () => {
    const { service, store, clock } = harness();
    await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({
        schedule: {
          type: "weekly",
          time: "09:00",
          weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
        },
      }),
    });
    const everyDayCard = store.messagesFor("thread-a")[0]!.card!;
    expect(everyDayCard.subtitle).toContain(
      "Will run every day; each run starts a fresh session.\n\nInstructions:",
    );

    await service.propose({
      botId: "bot-a",
      threadId: "thread-b",
      proposal: createProposal({
        schedule: { type: "once", at: new Date(clock.now + 60_000).toISOString() },
      }),
    });
    const onceCard = store.messagesFor("thread-b")[0]!.card!;
    expect(onceCard.subtitle).toContain(
      "Will run once; that run starts a fresh session.\n\nInstructions:",
    );
  });

  it("recomputes the run cadence line from the routine's effective schedule, not the change set", async () => {
    const { service, store, routines } = harness();
    const created = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ schedule: { type: "interval", everyMinutes: 5 } }),
    });
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: created.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "applied", action: "create" });
    const routineId = routines.listRoutines()[0]!.id;

    const apply = async (proposal: RoutineProposalInput) => {
      await service.propose({ botId: "bot-a", threadId: "thread-a", proposal });
      const card = store.messagesFor("thread-a").at(-1)!.card!;
      const result = service.resolve({
        botId: "bot-a",
        threadId: "thread-a",
        requestId: card.requestId!,
        behavior: "allow",
      });
      expect(result).toMatchObject({ claimed: true, state: "applied" });
      return card;
    };

    const scheduleChanged = await apply({
      action: "update",
      routineId,
      changes: { schedule: { type: "interval", everyMinutes: 60 } },
    });
    expect(scheduleChanged.subtitle).toContain(
      "Will run about 24 times a day; each run starts a fresh session.",
    );

    const nameOnly = await apply({
      action: "update",
      routineId,
      changes: { name: "Renamed brief" },
    });
    expect(nameOnly.subtitle).toContain(
      "Will run about 24 times a day; each run starts a fresh session.",
    );
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
        proposal: createProposal({ durationMinutes: 4 }),
      }),
    ).rejects.toThrow("durationMinutes must be a whole number from 5 to 240");
    await expect(
      service.propose({
        botId: "bot-a",
        threadId: "thread-a",
        proposal: createProposal({ timeoutMinutes: 4 }),
      }),
    ).rejects.toThrow("timeoutMinutes must be a whole number from 5 to 240");
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

  it("normalizes interval schedules with an optional cadence anchor", async () => {
    const now = Date.parse("2026-08-28T10:00:00Z");
    const { service, store, routines, clock } = harness(now);
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({
        schedule: {
          type: "interval",
          everyMinutes: 15,
          anchorAt: "2026-08-28T10:07:00Z",
        },
      }),
    });

    expect(proposed.summary).toContain("Every 15 minutes");
    expect(proposed.summary).toContain("no run limit");
    expect(store.messagesFor("thread-a")[0]?.card?.routineRequest?.operation).toMatchObject({
      action: "create",
      routine: {
        schedule: {
          type: "interval",
          everyMinutes: 15,
          anchorAt: Date.parse("2026-08-28T10:07:00Z"),
        },
      },
    });

    const withoutAnchor = await service.propose({
      botId: "bot-a",
      threadId: "thread-b",
      proposal: createProposal({ schedule: { type: "interval", everyMinutes: 5 } }),
    });
    expect(withoutAnchor.nextRunAt).toBeNull();
    expect(withoutAnchor.detail).toContain("One interval after confirmation");
    expect(store.messagesFor("thread-b")[0]?.card?.routineRequest?.operation).toMatchObject({
      action: "create",
      routine: { schedule: { type: "interval", everyMinutes: 5 } },
    });
    const deferred = store.messagesFor("thread-b")[0]?.card?.routineRequest?.operation;
    if (deferred?.action !== "create") throw new Error("Expected a create operation");
    expect(deferred.routine.schedule).not.toHaveProperty("anchorAt");

    clock.now = now + 7 * 60_000;
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-b",
      requestId: withoutAnchor.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "applied" });
    expect(routines.listRoutines().find((routine) => routine.sourceThreadId === "thread-b")).toMatchObject({
      schedule: { type: "interval", everyMinutes: 5, anchorAt: clock.now },
      nextRunAt: clock.now + 5 * 60_000,
    });

    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-c",
      proposal: createProposal({ schedule: { type: "interval", everyMinutes: 4 } }),
    })).rejects.toThrow(/5 to 1440/);
    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-c",
      proposal: createProposal({
        schedule: { type: "interval", everyMinutes: 5, anchorAt: "1969-12-31T23:59:59Z" },
      }),
    })).rejects.toThrow(/valid interval start time/);
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
    const proposal = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: createProposal({ durationMinutes: 5, timeoutMinutes: 15 }),
    });

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
      durationMinutes: 5,
      timeoutMinutes: 15,
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
    expect(routines.listRoutines()).toMatchObject([{
      botId: "bot-a",
      name: "Morning brief",
      enabled: true,
      durationMinutes: 5,
      timeoutMinutes: 15,
      sourceThreadId: "thread-a",
    }]);
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
      changes: {
        name: "New name",
        instructions: "New instructions",
        durationMinutes: 45,
        timeoutMinutes: 10,
      },
    });
    expect(routines.listRoutines()[0]).toMatchObject({
      name: "New name",
      prompt: "New instructions",
      durationMinutes: 45,
      timeoutMinutes: 10,
    });

    await apply({ action: "update", routineId: routine.id, changes: { timeoutMinutes: null } });
    expect(routines.listRoutines()[0]).not.toHaveProperty("timeoutMinutes");

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

  it("keeps a pending manage confirmation valid across recurring scheduler progress", async () => {
    const { service, routines, clock } = harness();
    const anchorAt = clock.now + 5 * 60_000;
    const routine = routines.create({
      botId: "bot-a",
      name: "Frequent check",
      prompt: "Check the queue",
      schedule: { type: "interval", everyMinutes: 5, anchorAt },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "Frequent review" } },
    });

    clock.now = anchorAt;
    await routines.tick();
    expect(routines.listRoutines()[0]).toMatchObject({
      updatedAt: routine.updatedAt,
      nextRunAt: anchorAt + 5 * 60_000,
    });
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "applied" });
    expect(routines.listRoutines()[0]).toMatchObject({ name: "Frequent review" });
  });

  it("invalidates a pending confirmation when a one-time routine auto-disables", async () => {
    const { service, routines, clock } = harness();
    const scheduledAt = clock.now + 5 * 60_000;
    const routine = routines.create({
      botId: "bot-a",
      name: "One-time check",
      prompt: "Check once",
      schedule: { type: "once", at: scheduledAt },
    });
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { action: "update", routineId: routine.id, changes: { name: "Renamed check" } },
    });

    clock.now = scheduledAt;
    await routines.tick();
    expect(routines.listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(routines.listRoutines()[0]!.updatedAt).toBeGreaterThan(routine.updatedAt);
    expect(service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    })).toMatchObject({ claimed: true, state: "invalid", status: 409 });
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

describe("cross-bot routine targeting", () => {
  function targetedHarness(validateTarget?: (proposerBotId: string, target: { botId: string; name: string }) => string | null) {
    const clock = { now: Date.parse("2026-08-28T10:00:00Z") };
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-target-"));
    tempDirs.push(dir);
    const routines = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => clock.now,
      botState: () => "busy",
      createTask: () => null,
      startTurn: async () => {},
    });
    const store = new MemoryStore();
    const service = new RoutineRequestService({
      store,
      routines,
      now: () => clock.now,
      timeZone: () => "Asia/Kolkata",
      validateTarget,
    });
    return { routines, service, store };
  }

  const forOps = { forBot: { botId: "bot-b", name: "Ops" } };

  it("binds the confirmed routine to the named target bot, not the proposer", async () => {
    const { routines, service, store } = targetedHarness();
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { ...createProposal(), ...forOps },
    });
    const card = store.messagesFor("thread-a")[0]?.card;
    expect(card?.title).toContain("for @Ops");
    expect(card?.subtitle).toContain("engine and permissions");
    expect(card?.routineRequest?.operation).toMatchObject({ action: "create", forBot: forOps.forBot });

    const result = service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    });
    expect(result).toMatchObject({ claimed: true, state: "applied", action: "create" });
    const created = routines.listRoutines();
    expect(created).toHaveLength(1);
    expect(created[0].botId).toBe("bot-b");
  });

  it("still schedules for the proposer when no target is named", async () => {
    const { routines, service } = targetedHarness();
    const proposed = await service.propose({ botId: "bot-a", threadId: "thread-a", proposal: createProposal() });
    service.resolve({ botId: "bot-a", threadId: "thread-a", requestId: proposed.requestId, behavior: "allow" });
    expect(routines.listRoutines()[0]?.botId).toBe("bot-a");
  });

  it("refuses at propose time when the target fails authorization", async () => {
    const { service } = targetedHarness(() => "@Ops belongs to a different section");
    await expect(service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { ...createProposal(), ...forOps },
    })).rejects.toMatchObject({ message: "@Ops belongs to a different section", status: 403 });
  });

  it("re-checks the target at confirm time — a deleted bot refuses without creating anything", async () => {
    let gone = false;
    const { routines, service, store } = targetedHarness(() => (gone ? "@Ops no longer exists, so this routine cannot be scheduled for it" : null));
    const proposed = await service.propose({
      botId: "bot-a",
      threadId: "thread-a",
      proposal: { ...createProposal(), ...forOps },
    });
    gone = true;
    const result = service.resolve({
      botId: "bot-a",
      threadId: "thread-a",
      requestId: proposed.requestId,
      behavior: "allow",
    });
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 404 });
    expect(routines.listRoutines()).toHaveLength(0);
    // the refusal is written back onto the card so the user sees why
    expect(store.messagesFor("thread-a")[0]?.card?.held).toMatch(/no longer exists/);
  });
});

describe("consequenceLine", () => {
  it("uses singular wording for one run a day and one day a week", () => {
    expect(consequenceLine({ type: "interval", everyMinutes: 1440 })).toBe(
      "Will run about once a day; each run starts a fresh session.",
    );
    expect(consequenceLine({ type: "daily", time: "09:00", weekdays: [1] })).toBe(
      "Will run one day a week; each run starts a fresh session.",
    );
    expect(consequenceLine({ type: "daily", time: "09:00", weekdays: [1, 3] })).toBe(
      "Will run 2 days a week; each run starts a fresh session.",
    );
    expect(consequenceLine({ type: "once", at: 0 })).toBe("Will run once; that run starts a fresh session.");
  });
});
