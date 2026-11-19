import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LogTail, parseQwenLogLine, classifyQuiet } from "./quiet-status.ts";

const dirs: string[] = [];
function fixture(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "omb-quiet-rotation-"));
  dirs.push(dir);
  const file = join(dir, "agent.log");
  writeFileSync(file, contents);
  const tail = new LogTail(file);
  expect(tail.read()).toEqual([]);
  return { file, tail, replace(text: string) { renameSync(file, `${file}.old`); writeFileSync(file, text); } };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("quiet log replacement", () => {
  it("reads a replacement whose size equals the previous log", () => {
    const h = fixture("old row\n");
    h.replace("new row\n");
    expect(h.tail.read()).toEqual(["new row"]);
    expect(h.tail.read()).toEqual([]);
  });

  it("reads a larger replacement from its beginning", () => {
    const h = fixture("old\n");
    h.replace("first new row\nsecond new row\n");
    expect(h.tail.read()).toEqual(["first new row", "second new row"]);
    appendFileSync(h.file, "third new row\n");
    expect(h.tail.read()).toEqual(["third new row"]);
  });

  it("does not join an unfinished old row to the replacement's first row", () => {
    const h = fixture("old\n");
    appendFileSync(h.file, "incomplete-old-row");
    expect(h.tail.read()).toEqual([]);
    h.replace("this new row is longer than the previous file\n");
    expect(h.tail.read()).toEqual(["this new row is longer than the previous file"]);
  });

  it("keeps observing retries when rotation includes a missing-file interval", () => {
    const h = fixture("old\n");
    renameSync(h.file, `${h.file}.old`);
    expect(h.tail.read()).toEqual([]);
    const retry = "[WARN] [RETRY] Attempt 3 failed with status 429. Retrying in 12s...";
    writeFileSync(h.file, `${retry}\n`);
    const lines = h.tail.read();
    expect(lines).toEqual([retry]);
    const logged = parseQwenLogLine(lines[0]!);
    expect(classifyQuiet({ logged, context: null, sample: { cpuMs: 0, connections: 0 }, previous: { cpuMs: 0, connections: 0 }, sinceMs: 15_000 }))
      .toEqual({ kind: "retrying", status: 429, delayMs: 12_000, attempt: 3 });
  });

  it("continues to ignore history on first open and follows same-file appends", () => {
    const h = fixture("old\n");
    appendFileSync(h.file, "new\n");
    expect(h.tail.read()).toEqual(["new"]);
    expect(h.tail.read()).toEqual([]);
  });

  it("keeps same-file truncation recovery", () => {
    const h = fixture("a long historical row\n");
    writeFileSync(h.file, "short\n");
    expect(h.tail.read()).toEqual(["short"]);
  });
});
