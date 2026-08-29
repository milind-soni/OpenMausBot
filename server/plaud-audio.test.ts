import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlaudCliTranscriber,
  parsePlaudCliRecordings,
  parsePlaudCliTranscript,
  plaudReceiptsToTranscriptItems,
  pollPlaudCliRecordings,
  scanPlaudAudio,
} from "./plaud-audio.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("scanPlaudAudio", () => {
  it("transcribes empty-note audio once by stable Plaud file id", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-plaud-"));
    roots.push(root);
    writeFileSync(join(root, "2026-08-26_call_deadbeef.m4a"), Buffer.from("test audio"));
    writeFileSync(join(root, "2026-08-26_call_deadbeef.md"), "# Call\n\n");
    const transcribe = vi.fn(async () => ({ id: "tx-1", text: "Speaker A: Useful transcript" }));
    const first = await scanPlaudAudio(root, null, transcribe);
    expect(first).toMatchObject({ status: "ok", items: [{ fileId: "deadbeef", transcriptId: "tx-1" }] });
    const second = await scanPlaudAudio(root, first.cursor, transcribe);
    expect(second).toMatchObject({ status: "empty", items: [] });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("redacts credentials copied into a local transcript before emitting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-plaud-secret-"));
    roots.push(root);
    writeFileSync(join(root, "call_deadbeef.m4a"), Buffer.from("test audio"));
    const secret = "Bearer abcdefghijklmnop1234";
    const result = await scanPlaudAudio(root, null, async () => ({ id: "tx-1", text: `Speaker A: ${secret}` }));
    expect(result.items[0]?.text).toContain("redacted");
    expect(result.items[0]?.text).not.toContain(secret);
  });

  it("does not upload audio that already has a meaningful archived note", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-plaud-"));
    roots.push(root);
    writeFileSync(join(root, "meeting_cafebabe.mp3"), Buffer.from("test audio"));
    writeFileSync(join(root, "meeting_cafebabe.md"), "# Meeting\n\nThis note already contains a detailed transcript and decisions.");
    const transcribe = vi.fn(async () => ({ id: "unused", text: "unused" }));
    const result = await scanPlaudAudio(root, null, transcribe);
    expect(result).toMatchObject({ status: "empty", items: [] });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("uses the installed Plaud CLI transcript command without passing an audio path", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "\nTranscript: Team call\n\nSpeaker A: Keep this decision.\n", stderr: "" };
    });
    const transcribe = createPlaudCliTranscriber({ run });
    const result = await transcribe("C:/Users/shane/Plaud Archive/team_call_deadbeef.m4a");
    expect(result).toEqual({ id: "deadbeef", text: "Speaker A: Keep this decision." });
    expect(calls).toEqual([["transcript", "deadbeef"]]);
    expect(JSON.stringify(calls)).not.toContain(".m4a");
  });

  it("treats an unavailable CLI transcript as fallback-eligible", async () => {
    const run = vi.fn(async () => ({ stdout: "No \"transaction\" transcript for this recording. Available: (none).", stderr: "" }));
    await expect(createPlaudCliTranscriber({ run })("meeting_cafebabe.mp3")).rejects.toThrow("transcript is unavailable");
    expect(parsePlaudCliTranscript("No \"transaction\" transcript for this recording.")).toBe("");
  });

  it("converts only text-bearing validated browser receipts to stable items", () => {
    const result = plaudReceiptsToTranscriptItems([{
      schemaVersion: 1,
      captureId: "11111111-1111-4111-8111-111111111111",
      capturedAt: "2026-08-26T13:00:00.000Z",
      sourceId: "plaud",
      url: "https://web.plaud.ai/recordings/1",
      title: "Plaud",
      items: [
        { kind: "transcript", title: "Call", text: "A transcript from the approved tab." },
        { kind: "page", title: "Metadata only" },
      ],
      cursor: { capturedAt: "2026-08-26T13:00:00.000Z", captureId: "11111111-1111-4111-8111-111111111111" },
    }]);
    expect(result).toMatchObject([{ fileId: "receipt-11111111-1111-4111-8111-111111111111-0", text: "A transcript from the approved tab." }]);
    expect(result).toHaveLength(1);
  });

  it("polls Plaud cloud recordings through the CLI and fetches each transcript once", async () => {
    const recent = `
Recordings in the last 14 days: 2

  ea3340024e896602260c7b8e5caef0e2  Strategy session  2026-08-26  18m42s
  d0ee925b0ec8ed441553121e52a01ee5  Product review  2026-08-25  32m16s
`;
    const calls: string[][] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "recent") return { stdout: recent, stderr: "" };
      if (args[0] === "file") {
        return {
          stdout: `File Details:\n\n  id: ${args[1]}\n  name: ${args[1] === "ea3340024e896602260c7b8e5caef0e2" ? "Strategy session" : "Product review"}\n  created_at: 2026-08-26T19:53:20\n  duration: 18m42s\n  transcript: available\n`,
          stderr: "",
        };
      }
      if (args[0] === "transcript") {
        return { stdout: `Transcript: Call\n\nSpeaker A: transcript for ${args.at(-1)}`, stderr: "" };
      }
      throw new Error(`unexpected Plaud args: ${args.join(" ")}`);
    });

    const first = await pollPlaudCliRecordings(null, { run, days: 14 });
    expect(first.status).toBe("ok");
    expect(first.items.map((item) => item.fileId)).toEqual([
      "ea3340024e896602260c7b8e5caef0e2",
      "d0ee925b0ec8ed441553121e52a01ee5",
    ]);
    expect(calls.filter(([command]) => command === "transcript")).toEqual([
      ["transcript", "--polished", "ea3340024e896602260c7b8e5caef0e2"],
      ["transcript", "--polished", "d0ee925b0ec8ed441553121e52a01ee5"],
    ]);

    calls.length = 0;
    const second = await pollPlaudCliRecordings(first.cursor, { run, days: 14 });
    expect(second).toMatchObject({ status: "empty", items: [] });
    expect(calls).toEqual([["recent", "--days", "14"]]);
  });

  it("bounds each cloud poll and resumes remaining recording ids next cycle", async () => {
    const ids = ["1111111111111111", "2222222222222222", "3333333333333333"];
    const run = async (args: readonly string[]) => {
      if (args[0] === "recent") {
        return { stdout: ids.map((id, index) => `${id}  Call ${index + 1}  2026-08-26  1m`).join("\n"), stderr: "" };
      }
      if (args[0] === "file") {
        return { stdout: "name: Call\ncreated_at: 2026-08-26T12:00:00Z\ntranscript: available", stderr: "" };
      }
      return { stdout: "Transcript: Call\n\nA useful transcript.", stderr: "" };
    };
    const first = await pollPlaudCliRecordings(null, { run, maxRecordings: 2 });
    expect(first.items.map((item) => item.fileId)).toEqual(ids.slice(0, 2));
    const second = await pollPlaudCliRecordings(first.cursor, { run, maxRecordings: 2 });
    expect(second.items.map((item) => item.fileId)).toEqual(ids.slice(2));
  });

  it("parses Plaud listing output without depending on titles or spinner text", () => {
    expect(parsePlaudCliRecordings(`- Fetching recordings...\n\n  abcdefabcdefabcdefabcdefabcdefab  A title with  spaces  2026-08-26  1h02m03s\n`)).toEqual([{
      id: "abcdefabcdefabcdefabcdefabcdefab",
      title: "A title with  spaces",
      date: "2026-08-26",
      duration: "1h02m03s",
    }]);
  });
});
