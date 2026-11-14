import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CdpConnection } from "./connection.ts";
import type { CdpTransport } from "./transport.ts";

vi.mock("node:fs", { spy: true });
vi.resetModules();
const { Downloads } = await import("./downloads.ts");

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "omb-download-cleanup-")); });
afterEach(() => {
  vi.mocked(rmSync).mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const listeners: Array<(message: string) => void> = [];
  const transport: CdpTransport = {
    send() {}, onMessage(listener) { listeners.push(listener); }, onClose() {}, close() {},
  };
  const connection = new CdpConnection(transport);
  const downloads = new Downloads(connection.root, directory, {
    ownerOf: () => "tab-a", limits: { maxBytes: 1024, perOwner: 1 },
  });
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener(JSON.stringify({ method, params }));
  };
  const begin = (guid: string, content = guid) => {
    emit("Browser.downloadWillBegin", { guid, frameId: "tab-a", url: "https://example.test/report", suggestedFilename: "report.txt" });
    writeFileSync(join(directory, guid), content);
    return downloads.list().find((entry) => entry.guid === guid)!;
  };
  const progress = (guid: string, state: "completed" | "canceled") => emit("Browser.downloadProgress", { guid, state });
  return { downloads, begin, progress };
}

function blockCleanup(): void {
  vi.mocked(rmSync).mockImplementationOnce(() => { throw Object.assign(new Error("file is busy"), { code: "EBUSY" }); });
}

it("publishes a completed file when removing an older retained download fails", () => {
  const { downloads, begin, progress } = setup();
  const older = begin("older");
  progress("older", "completed");
  const latest = begin("latest");
  const changed = vi.fn();
  downloads.onChange(changed);
  blockCleanup();
  progress("latest", "completed");
  expect(readFileSync(latest.path!, "utf8")).toBe("latest");
  expect(latest.state).toBe("completed");
  expect(existsSync(older.path!)).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith(latest);
  begin("next");
  progress("next", "completed");
  expect(existsSync(older.path!)).toBe(false);
  expect(downloads.list().map((entry) => entry.guid)).toEqual(["next"]);
});

it("publishes cancellation even when the partial file cannot be removed", () => {
  const { downloads, begin, progress } = setup();
  const partial = begin("partial");
  const changed = vi.fn();
  downloads.onChange(changed);
  blockCleanup();
  progress("partial", "canceled");
  expect(partial.state).toBe("canceled");
  expect(partial.finishedAt).not.toBeNull();
  expect(existsSync(join(directory, "partial"))).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith(partial);
});

it("publishes a rejected oversized file when cleanup also fails", () => {
  const { downloads, begin, progress } = setup();
  const oversized = begin("oversized", "x".repeat(1025));
  const changed = vi.fn();
  downloads.onChange(changed);
  blockCleanup();
  progress("oversized", "completed");
  expect(oversized.state).toBe("canceled");
  expect(oversized.path).toBeNull();
  expect(oversized.canceledBecause).toBe("larger than 1024 bytes");
  expect(changed).toHaveBeenCalledExactlyOnceWith(oversized);
});
