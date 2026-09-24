import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown, writeReport } from "./write-report.ts";
import type { ScenarioResult } from "../scorers/snapshot.ts";

const result: ScenarioResult = {
  id: "fixture",
  title: "A fixture scenario",
  behavior: "the pinned truth",
  world: "coordination",
  pass: false,
  startedAt: "2026-09-17T00:00:00.000Z",
  durationMs: 1234,
  steps: [{ step: { kind: "send", bot: "chief", text: "go" }, ok: true, detail: "receipt immediate", durationMs: 5 }],
  assertions: [
    { assertion: { kind: "turnOrder", bots: [] }, pass: false, detail: "expected chief, got lead" },
  ],
  assertionsInput: [{ kind: "turnOrder", bots: [] }],
  error: "boom",
};

describe("writeReport", () => {
  it("renders one markdown section per scenario with verdicts", () => {
    const markdown = renderMarkdown([result]);
    expect(markdown).toContain("# Behavior eval report");
    expect(markdown).toContain("FAIL — fixture (coordination)");
    expect(markdown).toContain("turnOrder");
    expect(markdown).toContain("Run error: boom");
  });

  it("writes a JSON and a markdown artifact per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-evals-report-"));
    try {
      const written = writeReport(dir, [result], "run-1");
      expect(existsSync(written.json)).toBe(true);
      expect(existsSync(written.markdown)).toBe(true);
      expect(JSON.parse(readFileSync(written.json, "utf8"))[0].id).toBe("fixture");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
