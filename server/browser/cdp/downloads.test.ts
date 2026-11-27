import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { CdpConnection } from "./connection.ts";
import { Downloads } from "./downloads.ts";
import type { CdpTransport } from "./transport.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "omb-download-retention-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

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
  return { downloads, complete };
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
