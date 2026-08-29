import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  browserReceiptsToLedgerItems,
  browserReceiptsToMemoryItems,
  enforceBrowserSourceSensitivity,
  normalizeBrowserCapture,
  readBrowserCaptureDirectory,
  storeBrowserCaptureReceipt,
  type BrowserCapturePayload,
} from "./browser-capture.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function payload(overrides: Partial<BrowserCapturePayload> = {}): BrowserCapturePayload {
  return {
    schemaVersion: 1,
    captureId: "11111111-1111-4111-8111-111111111111",
    capturedAt: "2026-08-26T13:00:00.000Z",
    sourceId: "youtube",
    url: "https://www.youtube.com/watch?v=secret-video&si=secret-session",
    title: "A useful video",
    items: [{ kind: "video", title: "A useful video" }],
    cursor: { capturedAt: "2026-08-26T13:00:00.000Z", captureId: "11111111-1111-4111-8111-111111111111" },
    ...overrides,
  };
}

describe("browser capture bridge", () => {
  it("stores direct extension receipts privately with bounded changed-event history", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);

    for (let index = 0; index < 14; index += 1) {
      const captureId = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
      expect(storeBrowserCaptureReceipt(payload({
        captureId,
        cursor: { capturedAt: "2026-08-26T13:00:00.000Z", captureId },
      }), dir)).not.toBeNull();
    }

    const events = readdirSync(dir).filter((name) => name.startsWith("openmausbot-capture-event-youtube-"));
    expect(events).toHaveLength(12);
    expect(storeBrowserCaptureReceipt({ ...payload(), sourceId: "plaud", url: "https://app.plaud.ai/", items: [] }, dir)).not.toBeNull();
    expect(readdirSync(dir)).toContain("openmausbot-capture-heartbeat-plaud.json");
  });

  it("never reports an unseeded browser source as a quiet successful read", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);

    const unseeded = readBrowserCaptureDirectory(dir, null, "google-messages");

    expect(unseeded.status).toBe("needs-auth");
    expect(unseeded.cursor).toBeNull();
    expect(unseeded.error).toContain("Google Messages");
  });

  it("fails closed when the last automatic browser observation is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);
    const cursor = {
      capturedAt: "2026-08-26T13:00:00.000Z",
      captureId: "11111111-1111-4111-8111-111111111111",
    };

    const stale = readBrowserCaptureDirectory(dir, cursor, "google-messages", {
      now: Date.parse("2026-08-26T13:16:00.000Z"),
      staleAfterMs: 15 * 60_000,
    });

    expect(stale.status).toBe("failed");
    expect(stale.error).toContain("stale");
  });

  it("fails closed when the newest unread receipt is already stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);
    writeFileSync(join(dir, "openmausbot-capture-old.json"), JSON.stringify(payload()));

    const stale = readBrowserCaptureDirectory(dir, null, "youtube", {
      now: Date.parse("2026-08-26T13:16:00.000Z"),
      staleAfterMs: 15 * 60_000,
    });

    expect(stale.status).toBe("failed");
    expect(stale.cursor).toBeNull();
    expect(stale.error).toContain("stale");
  });

  it("rejects receipts timestamped materially in the future", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);
    writeFileSync(join(dir, "openmausbot-capture-future.json"), JSON.stringify(payload({
      capturedAt: "2026-08-26T13:10:01.000Z",
      cursor: { capturedAt: "2026-08-26T13:10:01.000Z", captureId: "11111111-1111-4111-8111-111111111111" },
    })));

    const future = readBrowserCaptureDirectory(dir, null, "youtube", {
      now: Date.parse("2026-08-26T13:00:00.000Z"),
    });

    expect(future.status).toBe("failed");
    expect(future.cursor).toBeNull();
    expect(future.error).toContain("future");
  });

  it("strips query/session identifiers and rejects a source/host mismatch", () => {
    const receipt = normalizeBrowserCapture(payload());
    expect(receipt?.url).toBe("https://www.youtube.com/watch");
    expect(normalizeBrowserCapture(payload({ sourceId: "monarch" }))).toBeNull();
  });

  it("accepts Monarch's current app.monarch.com host", () => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId: "monarch",
      url: "https://app.monarch.com/dashboard?session=private",
      items: [{ kind: "record", title: "Account summary" }],
    }));

    expect(receipt).toMatchObject({
      sourceId: "monarch",
      url: "https://app.monarch.com/dashboard",
    });
  });

  it("redacts obvious credentials and converts receipts to evidence items", () => {
    const receipt = normalizeBrowserCapture(payload({
      items: [{ kind: "message", title: "Message", text: "Your verification code: 123456" }],
    }));
    expect(receipt?.items[0]?.text).toContain("[redacted]");
    expect(browserReceiptsToLedgerItems(receipt ? [receipt] : [])[0]).toMatchObject({
      sourceId: "youtube",
      evidenceRef: expect.stringContaining("capture=11111111-1111-4111-8111-111111111111"),
    });
  });

  it("converts receipts to stable memory inputs with receipt provenance", () => {
    const receipt = normalizeBrowserCapture(payload());
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("expected valid receipt");
    const items = browserReceiptsToMemoryItems([receipt], "capture", "Work", "browser-profile");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      botId: "capture",
      sectionId: "Work",
      sourceId: "youtube",
      accountId: "browser-profile",
      externalId: expect.stringMatching(/^browser:youtube:[a-f0-9]{64}$/),
      evidenceRef: expect.stringContaining("capture=11111111-1111-4111-8111-111111111111"),
      sensitivity: "internal",
    });
  });

  it("stores financial browser sources as restricted evidence", () => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId: "mercury",
      url: "https://app.mercury.com/dashboard",
      items: [{ kind: "record", title: "Mercury dashboard", text: "Visible account summary" }],
    }));
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("expected valid Mercury receipt");

    expect(browserReceiptsToMemoryItems([receipt], "capture")[0]?.sensitivity).toBe("restricted");
  });

  it("stores communications and transcripts as sensitive evidence", () => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId: "google-messages",
      url: "https://messages.google.com/web/conversations",
      items: [{ kind: "message", title: "Conversation", text: "Visible message preview" }],
    }));
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("expected valid Google Messages receipt");

    expect(browserReceiptsToMemoryItems([receipt], "capture")[0]?.sensitivity).toBe("sensitive");
  });

  it("uses a stable browser identity across repeated page observations", () => {
    const first = normalizeBrowserCapture(payload());
    const second = normalizeBrowserCapture(payload({
      captureId: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-08-26T13:05:00.000Z",
      cursor: { capturedAt: "2026-08-26T13:05:00.000Z", captureId: "22222222-2222-4222-8222-222222222222" },
    }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error("expected valid receipts");

    expect(browserReceiptsToMemoryItems([first], "capture")[0]?.externalId)
      .toBe(browserReceiptsToMemoryItems([second], "capture")[0]?.externalId);
  });

  it("enforces source-derived minimum sensitivity", () => {
    expect(enforceBrowserSourceSensitivity("mercury", "public")).toBe("restricted");
    expect(enforceBrowserSourceSensitivity("google-messages", "internal")).toBe("sensitive");
    expect(enforceBrowserSourceSensitivity("youtube", "restricted")).toBe("restricted");
    expect(enforceBrowserSourceSensitivity("gmail-account-1", "internal")).toBe("internal");
  });

  it("reads only new, valid stored receipts and advances the cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);
    writeFileSync(join(dir, "openmausbot-capture-1.json"), JSON.stringify(payload()));
    writeFileSync(join(dir, "openmausbot-capture-bad.json"), "not-json");
    mkdirSync(join(dir, "openmausbot-capture-folder.json"));
    const first = readBrowserCaptureDirectory(dir, null, undefined, {
      now: Date.parse("2026-08-26T13:05:00.000Z"),
    });
    expect(first.status).toBe("ok");
    expect(first.receipts).toHaveLength(1);
    expect(first.cursor?.captureId).toBe("11111111-1111-4111-8111-111111111111");
    expect(readBrowserCaptureDirectory(dir, first.cursor, undefined, {
      now: Date.parse("2026-08-26T13:05:00.000Z"),
    }).status).toBe("empty");
  });

  it("accepts Mercury only from an approved mercury.com host", () => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId: "mercury",
      url: "https://app.mercury.com/dashboard?account=private",
    }));
    expect(receipt?.sourceId).toBe("mercury");
    expect(receipt?.url).toBe("https://app.mercury.com/dashboard");
  });

  it.each([
    ["ai-chatgpt", "https://chatgpt.com/"],
    ["ai-claude", "https://claude.ai/"],
    ["ai-grok", "https://grok.com/"],
    ["ai-gemini", "https://gemini.google.com/app"],
  ] as const)("accepts %s metadata only from its approved host", (sourceId, url) => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId,
      url,
      items: [{ kind: "record", title: "Visible sidebar thread" }],
    }));
    expect(receipt?.sourceId).toBe(sourceId);
    expect(receipt?.items[0]?.text).toBeUndefined();
  });

  it("strips AI portal body text at the server trust boundary", () => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId: "ai-chatgpt",
      url: "https://chatgpt.com/",
      items: [{ kind: "record", title: "Visible sidebar thread", text: "private prompt and response" }],
    }));

    expect(receipt?.items).toEqual([{ kind: "record", title: "Visible sidebar thread" }]);
  });

  it("stores AI portal thread-title evidence as sensitive", () => {
    const receipt = normalizeBrowserCapture(payload({
      sourceId: "ai-chatgpt",
      url: "https://chatgpt.com/",
      items: [{ kind: "record", title: "Visible sidebar thread" }],
    }));
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("expected valid AI portal receipt");
    expect(browserReceiptsToMemoryItems([receipt], "capture")[0]?.sensitivity).toBe("sensitive");
  });

  it("keeps independent cursors when a folder contains multiple browser sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-browser-capture-"));
    dirs.push(dir);
    writeFileSync(join(dir, "openmausbot-capture-youtube.json"), JSON.stringify(payload()));
    writeFileSync(join(dir, "openmausbot-capture-monarch.json"), JSON.stringify(payload({
      captureId: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-08-26T13:01:00.000Z",
      sourceId: "monarch",
      url: "https://app.monarchmoney.com/accounts?session=private",
      cursor: { capturedAt: "2026-08-26T13:01:00.000Z", captureId: "22222222-2222-4222-8222-222222222222" },
    })));
    const youtube = readBrowserCaptureDirectory(dir, null, "youtube", {
      now: Date.parse("2026-08-26T13:05:00.000Z"),
    });
    const monarch = readBrowserCaptureDirectory(dir, null, "monarch", {
      now: Date.parse("2026-08-26T13:05:00.000Z"),
    });
    expect(youtube.receipts.map((receipt) => receipt.sourceId)).toEqual(["youtube"]);
    expect(monarch.receipts.map((receipt) => receipt.sourceId)).toEqual(["monarch"]);
  });
});
