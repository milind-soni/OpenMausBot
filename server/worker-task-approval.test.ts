// The only human gate on the worker path, so these tests care about two things
// above all: that the card says enough for a person to actually decide, and
// that nothing about it can be answered by anything other than a person.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";
import { HOST_TASK_PLATFORM, parsedManifest, workerFixture } from "./testing/worker-task.ts";
import {
  cancelWorkerTaskApprovalsForThread,
  cancelWorkerTaskApprovalsForWorker,
  describeWorkerTask,
  dismissStaleWorkerTaskCards,
  requestWorkerTaskApproval,
  resolveWorkerTaskApproval,
  type WorkerApprovalBus,
} from "./worker-task-approval.ts";
import { workerTaskManifestDigest } from "./worker-task-manifest.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
const worker = workerFixture();
const manifest = parsedManifest();
const digest = workerTaskManifestDigest(manifest);

let store: Store;
let bus: WorkerApprovalBus;
let bot: BotRecord;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(selection);
  bus = { store, broadcast: () => {} };
  bot = store.createBot();
});

// The pending map lives in the module, exactly as peer-approval's does. Settle
// anything a test left open while its store is still alive — settling a card
// after the store is gone would throw inside the cleanup itself.
afterEach(() => {
  cancelWorkerTaskApprovalsForWorker(worker.id);
  cancelWorkerTaskApprovalsForWorker("other-worker");
});

const openCard = (threadId: string) =>
  store.messagesFor(threadId).find((message) => message.card?.tool?.startsWith("worker_task:"));

describe("the approval card", () => {
  it("says which machine, what surface, and exactly what will run", () => {
    const text = describeWorkerTask(worker, manifest);
    expect(text).toContain(worker.displayName);
    expect(text).toContain(HOST_TASK_PLATFORM === "windows" ? "Windows" : "macOS");
    expect(text).toContain("desktop");
    expect(text).toContain(manifest.commands[0].executable);
    expect(text).toContain("Expires");
  });

  it("never names the SSH alias", () => {
    // #508 item 7: the transport identity stays out of anything a bot, a
    // device client, or an export can read — and a card is all three.
    expect(describeWorkerTask(worker, manifest)).not.toContain(worker.sshAlias);
  });

  it("lists the origins a browser task may reach", () => {
    const browser = parsedManifest(HOST_TASK_PLATFORM, { surface: "browser", origins: ["https://example.com"] });
    expect(describeWorkerTask(worker, browser)).toContain("https://example.com");
  });

  it("offers Allow and Deny, and never an always-allow grant", () => {
    void requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    const card = openCard(bot.threadId)?.card;
    expect(card?.options).toEqual(["Allow", "Deny"]);
    // An always-allow key would be a grant over a digest that changes with
    // every document — it could only ever be wrong.
    expect(card?.allowKey).toBeUndefined();
    expect(card?.approvalScope).toBe("remote-worker-computer");
    expect(card?.tool).toBe(`worker_task:${digest.slice(0, 12)}`);
  });
});

describe("answering", () => {
  it("resolves allow and settles the card", async () => {
    const pending = requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    const requestId = openCard(bot.threadId)?.card?.requestId ?? "";
    expect(resolveWorkerTaskApproval(requestId, "allow")).toBe(true);
    await expect(pending).resolves.toBe("allow");
    expect(openCard(bot.threadId)?.card?.answered).toBe("allow");
  });

  it("resolves deny and settles the card", async () => {
    const pending = requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    const requestId = openCard(bot.threadId)?.card?.requestId ?? "";
    expect(resolveWorkerTaskApproval(requestId, "deny")).toBe(true);
    await expect(pending).resolves.toBe("deny");
  });

  it("treats anything that is not an explicit allow as a denial", async () => {
    const pending = requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    const requestId = openCard(bot.threadId)?.card?.requestId ?? "";
    resolveWorkerTaskApproval(requestId, "answer");
    await expect(pending).resolves.toBe("deny");
  });

  it("passes an unknown request id through to the provider adapter", () => {
    expect(resolveWorkerTaskApproval("not-a-worker-task", "allow")).toBe(false);
  });

  it("cannot be answered twice", async () => {
    const pending = requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    const requestId = openCard(bot.threadId)?.card?.requestId ?? "";
    resolveWorkerTaskApproval(requestId, "allow");
    await pending;
    expect(resolveWorkerTaskApproval(requestId, "allow")).toBe(false);
  });
});

describe("cancellation", () => {
  it("one worker going offline leaves the other worker's approval pending", async () => {
    const other = workerFixture(HOST_TASK_PLATFORM, { id: "other-worker", displayName: "Other" });
    const mine = requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    const second = store.createBot();
    const theirs = requestWorkerTaskApproval(bus, other, manifest, digest, second.threadId);

    // #508 acceptance item 6, at the approval layer: disconnecting one worker
    // must not disturb anything belonging to the other.
    expect(cancelWorkerTaskApprovalsForWorker(worker.id)).toBe(1);
    await expect(mine).resolves.toBe("deny");

    const theirRequestId = openCard(second.threadId)?.card?.requestId ?? "";
    expect(resolveWorkerTaskApproval(theirRequestId, "allow")).toBe(true);
    await expect(theirs).resolves.toBe("allow");
  });

  it("an interrupted turn denies its own thread's approval rather than waiting out the timer", async () => {
    const pending = requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    expect(cancelWorkerTaskApprovalsForThread(bot.threadId)).toBe(1);
    await expect(pending).resolves.toBe("deny");
    expect(openCard(bot.threadId)?.card?.dismissed).toBe(true);
  });
});

describe("stale cards from a previous run", () => {
  it("are settled at boot, so the composer is not blocked forever", () => {
    // A card with no in-memory resolver: exactly what a crashed process leaves.
    store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Run a task on macOS guest",
        subtitle: "…",
        options: ["Allow", "Deny"],
        requestId: "gone-with-the-process",
        tool: `worker_task:${digest.slice(0, 12)}`,
      },
    });
    expect(dismissStaleWorkerTaskCards(bus)).toBe(1);
    expect(openCard(bot.threadId)?.card?.answered).toBe("deny");
  });

  it("leaves a card whose approval is still pending alone", () => {
    void requestWorkerTaskApproval(bus, worker, manifest, digest, bot.threadId);
    expect(dismissStaleWorkerTaskCards(bus)).toBe(0);
    expect(openCard(bot.threadId)?.card?.answered).toBeUndefined();
  });
});

describe("the auto-approval rules agree", () => {
  const scoped = { scope: "remote-worker-computer" } as const;

  it("a remembered always-allow grant cannot answer a worker request", () => {
    const granted = { ...bot, autoApprove: false, alwaysAllow: ["worker_task:abc"] };
    expect(autoVerdict(granted, "worker_task:abc", "run a task", scoped).approve).toBeNull();
  });

  it("and neither can auto mode's unclassified-GUI allowance without it being on", () => {
    expect(autoVerdict({ ...bot, autoApprove: false }, "click", "click at 10,10", scoped).approve).toBeNull();
  });
});
