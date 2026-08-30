import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserCleanupCoordinator,
  finalizeBrowserCleanupMutation,
  requireBrowserCleanupAcknowledged,
} from "./browser-lifecycle-cleanup.ts";

const folders: string[] = [];
const journal = () => {
  const folder = mkdtempSync(join(tmpdir(), "openmaus-browser-cleanup-"));
  folders.push(folder);
  return join(folder, "browser-cleanups.json");
};

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("durable browser lifecycle cleanup", () => {
  it("keeps a deletion journaled until Electron acknowledges the wipe", async () => {
    const file = journal();
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        const { requestId } = message;
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId,
          ok: true,
        }));
        return true;
      },
    });
    const prepared = coordinator.prepare("profile", "work");
    expect(coordinator.hasPendingProfile("work")).toBe(true);
    const request = coordinator.commit(prepared);

    await expect(coordinator.ensure(request)).resolves.toBe(true);
    expect(coordinator.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("does not report completion without an ACK and blocks profile-id reuse across restart", async () => {
    const file = journal();
    const coordinator = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 10,
      retryMs: [60_000],
      send: () => true,
    });
    const request = coordinator.commit(coordinator.prepare("profile", "client_1"));

    const acknowledged = await coordinator.ensure(request);
    expect(acknowledged).toBe(false);
    expect(() => requireBrowserCleanupAcknowledged(acknowledged, "The browser profile"))
      .toThrow(expect.objectContaining({ status: 503 }));
    expect(coordinator.hasPendingProfile("client_1")).toBe(true);

    const afterRestart = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 10,
      retryMs: [60_000],
      send: () => false,
    });
    expect(afterRestart.hasPendingProfile("client_1")).toBe(true);
    expect(afterRestart.pending()).toEqual([request]);
  });

  it("locks the canonical profile id while wiping its exact legacy partition", async () => {
    const file = journal();
    let sentProfileId = "";
    let coordinator!: BrowserCleanupCoordinator;
    coordinator = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 50,
      retryMs: [60_000],
      send(message) {
        sentProfileId = message.partitionId ?? "";
        queueMicrotask(() => coordinator.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: true,
        }));
        return true;
      },
    });
    const request = coordinator.commit(coordinator.prepare("profile", "work-2", "Work"));
    expect(coordinator.hasPendingProfile("work-2")).toBe(true);
    expect(coordinator.hasPendingProfile("different-id", "work")).toBe(true);
    expect(coordinator.committedProfileIds()).toEqual(["work-2"]);

    await expect(coordinator.ensure(request)).resolves.toBe(true);
    expect(sentProfileId).toBe("Work");
    expect(coordinator.hasPendingProfile("work-2")).toBe(false);
    expect(coordinator.committedProfileIds()).toEqual([]);
  });

  it("does not dispatch an ambiguous prepared intent after a crash", async () => {
    const file = journal();
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });
    const request = coordinator.prepare("profile", "client-crash");

    let sends = 0;
    const afterRestart = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 10,
      retryMs: [10],
      send: () => {
        sends += 1;
        return true;
      },
    });
    afterRestart.startPending();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sends).toBe(0);
    expect(afterRestart.pending()).toEqual([request]);
    expect(afterRestart.hasPendingProfile("client-crash")).toBe(true);
    expect(afterRestart.committedProfileIds()).toEqual([]);
    await expect(afterRestart.ensure(request)).resolves.toBe(false);
  });

  it("replays only an explicitly committed intent after a crash", async () => {
    const file = journal();
    const beforeCrash = new BrowserCleanupCoordinator({ file, send: () => false });
    const request = beforeCrash.commit(beforeCrash.prepare("profile", "client-committed"));

    let afterRestart!: BrowserCleanupCoordinator;
    afterRestart = new BrowserCleanupCoordinator({
      file,
      timeoutMs: 50,
      retryMs: [10],
      send(message) {
        queueMicrotask(() => afterRestart.receive({
          type: "openmausbot:browser-lifecycle-result",
          requestId: message.requestId,
          ok: true,
        }));
        return true;
      },
    });
    await expect(afterRestart.ensure(request)).resolves.toBe(true);
    expect(afterRestart.pending()).toEqual([]);
  });

  it("treats malformed journal JSON as unknown state and blocks profile reuse", () => {
    const file = journal();
    writeFileSync(file, "{ definitely not json");
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });

    expect(() => coordinator.hasPendingProfile("work")).toThrow(expect.objectContaining({
      status: 503,
      message: expect.stringMatching(/could not be read safely.*blocked/i),
    }));
    expect(() => coordinator.prepare("profile", "work")).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => coordinator.pending()).toThrow(expect.objectContaining({ status: 503 }));
  });

  it("rejects a syntactically valid journal containing an invalid entry", () => {
    const file = journal();
    writeFileSync(file, JSON.stringify([{
      requestId: "00000000-0000-4000-8000-000000000000",
      kind: "profile",
      id: "work",
      phase: "maybe",
    }]));
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });

    expect(() => coordinator.hasPendingProfile("work")).toThrow(expect.objectContaining({
      status: 503,
      message: expect.stringMatching(/invalid browser cleanup journal/i),
    }));
  });

  it("uses ENOENT alone as the empty-journal state", () => {
    const file = journal();
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });
    expect(coordinator.pending()).toEqual([]);
    expect(coordinator.hasPendingProfile("work")).toBe(false);
  });

  it("runs mandatory post-config effects when the commit journal write fails", async () => {
    const file = journal();
    let writes = 0;
    const events: string[] = [];
    const coordinator = new BrowserCleanupCoordinator({
      file,
      send: () => false,
      write(path, data, options) {
        writes += 1;
        if (writes === 2) throw new Error("simulated commit journal failure");
        writeFileSync(path, data, options);
      },
    });
    const request = coordinator.prepare("profile", "work");

    await expect(finalizeBrowserCleanupMutation({
      requests: [request],
      commit(entry) {
        events.push("commit");
        return coordinator.commit(entry);
      },
      ensure(entry) {
        events.push("ensure");
        return coordinator.ensure(entry);
      },
      async mandatory() {
        events.push("mandatory");
        return "status";
      },
    })).rejects.toThrow("simulated commit journal failure");

    expect(events).toEqual(["commit", "mandatory"]);
    expect(coordinator.pending()).toEqual([request]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([request]);
  });
});
