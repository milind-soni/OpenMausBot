import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";
import type { Bot, BotAnnouncement } from "./store";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "bot-1",
  threadId: "thread-1",
  name: "Maus",
  title: "Helper",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "fixture", model: "default" },
  messages: [],
  ...overrides,
});

interface DeferredBot {
  promise: Promise<BotAnnouncement>;
  resolve: (value: BotAnnouncement) => void;
  reject: (error: Error) => void;
}

const deferredBot = (): DeferredBot => {
  let resolve!: DeferredBot["resolve"];
  let reject!: DeferredBot["reject"];
  const promise = new Promise<BotAnnouncement>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("bot patch queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts approval and model changes immediately instead of debouncing execution settings", async () => {
    const send = vi.fn(async () => bot());
    const queue = createBotPatchQueue({
      send,
      reconcile: async () => bot(),
      onAuthoritative: vi.fn(),
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { approvalMode: "ask" }, bot({ approvalMode: "auto" }));
    await vi.runAllTicks();
    expect(send).toHaveBeenCalledWith(
      "bot-1",
      { approvalMode: "ask" },
      expect.any(AbortSignal),
      expect.objectContaining({ approvalMode: "auto" }),
    );

    await queue.flush("bot-1");
    queue.enqueue(
      "bot-1",
      { modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } },
      bot(),
    );
    await vi.runAllTicks();
    expect(send).toHaveBeenLastCalledWith(
      "bot-1",
      { modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } },
      expect.any(AbortSignal),
      expect.objectContaining({ id: "bot-1" }),
    );
  });

  it("aborts an in-flight trusted grant when a newer approval level arrives", async () => {
    const sent: BotUpdatePatch[] = [];
    const signals: AbortSignal[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch, signal) => {
        sent.push(patch);
        signals.push(signal);
        if (sent.length === 1) {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("superseded", "AbortError")),
              { once: true },
            );
          });
        }
        return bot({ approvalMode: patch.approvalMode });
      },
      reconcile: async () => bot(),
      onAuthoritative: vi.fn(),
      onError: vi.fn(),
    });

    queue.enqueue(
      "bot-1",
      { approvalMode: "full", confirmFullAccess: true },
      bot({ approvalMode: "ask" }),
    );
    await vi.runAllTicks();
    expect(signals[0]?.aborted).toBe(false);

    queue.enqueue("bot-1", { approvalMode: "ask" }, bot({ approvalMode: "full" }));
    expect(signals[0]?.aborted).toBe(true);
    await vi.runAllTicks();
    await queue.flush("bot-1");

    expect(sent).toEqual([
      { approvalMode: "full", confirmFullAccess: true },
      { approvalMode: "ask" },
    ]);
  });

  it("flush waits for the PATCH and returns the server-authoritative computer selection", async () => {
    const request = deferredBot();
    const send = vi.fn(async () => request.promise);
    const queue = createBotPatchQueue({
      send,
      reconcile: async () => bot(),
      onAuthoritative: vi.fn(),
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { computer: "cloud", cloudBackend: "vps" }, bot());
    const flushed = queue.flush("bot-1");
    let settled = false;
    void flushed.then(() => { settled = true; });
    await Promise.resolve();

    expect(send).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    request.resolve(bot({ computer: "cloud", cloudBackend: "vps" }));
    await expect(flushed).resolves.toMatchObject({ computer: "cloud", cloudBackend: "vps" });
  });

  it("coalesces upload then remove so an older avatar can never resurrect", async () => {
    const sent: BotUpdatePatch[] = [];
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot({ ...patch, computer: patch.computer ?? undefined });
      },
      reconcile: async () => bot(),
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue(
      "bot-1",
      { avatarUrl: "/api/attachments/avatar.webp", avatarCrop: "circle" },
      bot(),
    );
    await vi.advanceTimersByTimeAsync(200);
    queue.enqueue("bot-1", { avatarUrl: null, avatarCrop: "mascot" }, bot());
    await vi.advanceTimersByTimeAsync(399);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toEqual([{ avatarUrl: null, avatarCrop: "mascot" }]);
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ avatarUrl: null, avatarCrop: "mascot" }),
      {},
    );
  });

  it("serializes in-flight profile edits and overlays only the later values", async () => {
    const first = deferredBot();
    const second = deferredBot();
    const sent: BotUpdatePatch[] = [];
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: (_botId, patch) => {
        sent.push(patch);
        return sent.length === 1 ? first.promise : second.promise;
      },
      reconcile: async () => bot(),
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { name: "First" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    queue.enqueue(
      "bot-1",
      {
        name: "Second",
        title: "Updated title",
        description: "Updated description",
        notifications: false,
        voice: "voice-2",
        speakReplies: true,
      },
      bot(),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(sent).toEqual([{ name: "First" }]);

    first.resolve(bot({ name: "First" }));
    await vi.runAllTicks();
    await Promise.resolve();
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "First" }),
      expect.objectContaining({ name: "Second", voice: "voice-2", speakReplies: true }),
    );
    expect(sent[1]).toMatchObject({
      name: "Second",
      title: "Updated title",
      description: "Updated description",
      notifications: false,
      voice: "voice-2",
      speakReplies: true,
    });

    second.resolve(bot({ name: "Second", voice: "voice-2", speakReplies: true }));
    await vi.runAllTicks();
    await queue.flush("bot-1");
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Second", voice: "voice-2", speakReplies: true }),
      {},
    );
  });

  it("reconciles a rejected optimistic profile value to the server bot", async () => {
    const authoritative = vi.fn();
    const onError = vi.fn();
    const serverBot = bot({ name: "Server name" });
    const queue = createBotPatchQueue({
      send: async () => {
        throw new Error("name must be at most 100 characters");
      },
      reconcile: async () => serverBot,
      onAuthoritative: authoritative,
      onError,
    });

    queue.enqueue("bot-1", { name: "x".repeat(101) }, bot());
    await vi.advanceTimersByTimeAsync(400);

    expect(authoritative).toHaveBeenCalledWith(serverBot, {});
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "name must be at most 100 characters" }),
    );
  });

  it("does not restore a bot whose queued mutation was cancelled for deletion", async () => {
    const request = deferredBot();
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: async () => request.promise,
      reconcile: async () => null,
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { name: "Pending" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    queue.cancel("bot-1");
    request.resolve(bot({ name: "Pending" }));
    await vi.runAllTicks();
    await Promise.resolve();

    expect(authoritative).not.toHaveBeenCalled();
    expect(queue.overlayFor("bot-1")).toEqual({});
  });

  it("does not restore a bot cancelled while a failed mutation is reconciling", async () => {
    const reconciliation = deferredBot();
    const authoritative = vi.fn();
    const onError = vi.fn();
    const reconcile = vi.fn(async () => reconciliation.promise);
    const queue = createBotPatchQueue({
      send: async () => {
        throw new Error("patch failed");
      },
      reconcile,
      onAuthoritative: authoritative,
      onError,
    });

    queue.enqueue("bot-1", { name: "Pending" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    expect(reconcile).toHaveBeenCalledOnce();

    queue.cancel("bot-1");
    reconciliation.resolve(bot({ name: "Server name" }));
    await vi.runAllTicks();
    await Promise.resolve();

    expect(authoritative).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(queue.overlayFor("bot-1")).toEqual({});
  });

  it("carries acknowledgeLocalAuto to the wire but never into a state overlay", async () => {
    // The consent flag is the server's proof the local-auto warning dialog was
    // shown (server/index.ts gate). Coalesced with other edits it must still
    // reach the HTTP body — and must never fold back into renderer bot state.
    const sent: BotUpdatePatch[] = [];
    const overlays: BotUpdatePatch[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot();
      },
      reconcile: async () => bot(),
      onAuthoritative: (_bot, overlay) => overlays.push(overlay),
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { computer: "local", acknowledgeLocalAuto: true }, bot());
    queue.enqueue("bot-1", { title: "Ops" }, bot());
    expect(queue.overlayFor("bot-1")).toEqual({ computer: "local", title: "Ops" });
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush("bot-1");

    expect(sent).toEqual([{ computer: "local", acknowledgeLocalAuto: true, title: "Ops" }]);
    for (const overlay of overlays) expect(overlay).not.toHaveProperty("acknowledgeLocalAuto");
  });

  it("keeps the Full access confirmation out of optimistic bot state", async () => {
    const sent: BotUpdatePatch[] = [];
    const overlays: BotUpdatePatch[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot();
      },
      reconcile: async () => bot(),
      onAuthoritative: (_bot, overlay) => overlays.push(overlay),
      onError: vi.fn(),
    });

    queue.enqueue(
      "bot-1",
      { approvalMode: "full", confirmFullAccess: true },
      bot(),
    );
    queue.enqueue("bot-1", { title: "Ops" }, bot());
    expect(queue.overlayFor("bot-1")).toEqual({ approvalMode: "full", title: "Ops" });
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush("bot-1");

    expect(sent).toEqual([
      { approvalMode: "full", confirmFullAccess: true },
      { title: "Ops" },
    ]);
    for (const overlay of overlays) expect(overlay).not.toHaveProperty("confirmFullAccess");
  });

  it("sends null to select Auto but normalizes it to an absent state field", async () => {
    const sent: BotUpdatePatch[] = [];
    const overlays: BotUpdatePatch[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot();
      },
      reconcile: async () => bot(),
      onAuthoritative: (_bot, overlay) => overlays.push(overlay),
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { computer: null }, bot({ computer: "cloud" }));
    expect(queue.overlayFor("bot-1")).toEqual({ computer: undefined });
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush("bot-1");

    expect(sent).toEqual([{ computer: null }]);
    expect(overlays).toEqual([{ computer: undefined }]);
  });

  it("revive undoes a dispose, so StrictMode's dev probe cannot kill saving", async () => {
    // StrictMode mounts, runs the cleanup once against the same memoized
    // queue, and mounts again. dispose → revive must leave a working queue.
    const sent: BotUpdatePatch[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot();
      },
      reconcile: async () => bot(),
      onAuthoritative: vi.fn(),
      onError: vi.fn(),
    });

    queue.dispose();
    queue.revive();
    queue.enqueue("bot-1", { title: "still saves" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush("bot-1");
    expect(sent).toEqual([{ title: "still saves" }]);
  });
});
