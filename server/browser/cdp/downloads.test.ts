import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CdpConnection } from "./connection.ts";
import { Downloads } from "./downloads.ts";
import type { CdpTransport } from "./transport.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "omb-download-retention-")); });
afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const listeners: Array<(message: string) => void> = [];
  const transport: CdpTransport = {
    send() {},
    onMessage(listener) { listeners.push(listener); },
    onClose() {},
    close() {},
  };
  const connection = new CdpConnection(transport);
  const downloads = new Downloads(connection.root, directory, {
    ownerOf: (frame) => frame || null,
    limits: { maxBytes: 1024, perOwner: 1 },
  });
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener(JSON.stringify({ method, params }));
  };
  const complete = (guid: string, frameId = "") => {
    emit("Browser.downloadWillBegin", { guid, frameId, url: "https://example.test/report", suggestedFilename: "report.txt" });
    writeFileSync(join(directory, guid), guid);
    emit("Browser.downloadProgress", { guid, state: "completed", receivedBytes: guid.length, totalBytes: guid.length });
    const download = downloads.list().find((item) => item.guid === guid)!;
    expect(download.state).toBe("completed");
    return download;
  };
  return { downloads, complete, emit };
}

it("an unowned download never evicts files retained by identified tabs", () => {
  const { downloads, complete } = setup();
  const a = complete("tab-a-report", "tab-a");
  const b = complete("tab-b-report", "tab-b");
  complete("unknown-report");
  expect(existsSync(a.path!)).toBe(true);
  expect(existsSync(b.path!)).toBe(true);
  expect(downloads.list()).toHaveLength(3);
});

it("the unowned retention bucket evicts only its own oldest completed file", () => {
  const { downloads, complete } = setup();
  const first = complete("unknown-first");
  const owned = complete("owned", "tab-a");
  const newest = complete("unknown-newest");
  expect(existsSync(first.path!)).toBe(false);
  expect(existsSync(owned.path!)).toBe(true);
  expect(existsSync(newest.path!)).toBe(true);
  expect(downloads.list().map((item) => item.guid)).toEqual(["owned", "unknown-newest"]);
});

it("identified tabs keep their existing independent retention limits", () => {
  const { downloads, complete } = setup();
  const first = complete("a-first", "tab-a");
  const other = complete("b-first", "tab-b");
  complete("a-newest", "tab-a");
  expect(existsSync(first.path!)).toBe(false);
  expect(existsSync(other.path!)).toBe(true);
  expect(downloads.list("tab-a").map((item) => item.guid)).toEqual(["a-newest"]);
});

it("retains the last completed download when concurrent files finish out of start order", () => {
  vi.useFakeTimers();
  const { downloads, complete, emit } = setup();
  emit("Browser.downloadWillBegin", { guid: "slow", frameId: "tab-a", url: "https://example.test/slow", suggestedFilename: "slow.txt" });
  writeFileSync(join(directory, "slow"), "slow download");
  const fast = complete("fast", "tab-a");
  const slow = downloads.list().find((entry) => entry.guid === "slow")!;
  const completedPaths: string[] = [];
  downloads.onChange((entry) => {
    if (entry.state === "completed") {
      expect(existsSync(entry.path!)).toBe(true);
      completedPaths.push(entry.path!);
    }
  });
  emit("Browser.downloadProgress", { guid: "slow", state: "completed", receivedBytes: 13 });
  expect(slow.finishedAt).toBe(fast.finishedAt);
  expect(downloads.list("tab-a").map((entry) => entry.guid)).toEqual(["slow"]);
  expect(existsSync(slow.path!)).toBe(true);
  expect(existsSync(fast.path!)).toBe(false);
  expect(completedPaths).toEqual([slow.path]);
  const next = complete("next", "tab-a");
  expect(existsSync(slow.path!)).toBe(false);
  expect(existsSync(next.path!)).toBe(true);
  expect(downloads.list("tab-a").map((entry) => entry.guid)).toEqual(["next"]);
});
