import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserCleanupCoordinator,
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
    const request = coordinator.prepare("profile", "work");
    expect(coordinator.hasPendingProfile("work")).toBe(true);

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
    const request = coordinator.prepare("profile", "client_1");

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

  it("drops a pre-commit intent when boot reconciliation finds the target still exists", () => {
    const file = journal();
    const coordinator = new BrowserCleanupCoordinator({ file, send: () => false });
    coordinator.prepare("bot", "bot-a");
    coordinator.reconcile(() => false);
    expect(coordinator.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });
});
