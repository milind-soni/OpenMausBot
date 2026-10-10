import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "../scorers/snapshot.ts";

/** One JSON and one markdown report per run, plus nothing else: the reports
 * are the release-diffable artifact the behavior report is built from. */

export function renderMarkdown(results: ScenarioResult[]): string {
  const lines: string[] = [
    "# Behavior eval report",
    "",
    "- Generated: " + new Date().toISOString(),
    "- Outcome: " + (results.every((result) => result.pass) ? "PASS" : "FAIL"),
    "- Scenarios: " + results.length + " (" + results.filter((result) => result.pass).length + " passed)",
    "",
  ];
  for (const result of results) {
    lines.push("## " + (result.pass ? "PASS" : "FAIL") + " — " + result.id + " (" + result.world + ")", "");
    lines.push(result.title, "", "Pinned behavior: " + result.behavior, "");
    if (result.error) lines.push("Run error: " + result.error, "");
    lines.push("Duration: " + Math.round(result.durationMs / 100) / 10 + "s", "");
    lines.push("### Assertions", "");
    for (const assertion of result.assertions) {
      lines.push("- " + (assertion.pass ? "pass" : "FAIL") + " — " + assertion.assertion.kind + ": " + assertion.detail.replaceAll("\n", " "));
    }
    lines.push("", "### Steps", "");
    for (const step of result.steps) {
      const kind = typeof step.step === "object" && step.step !== null && "kind" in step.step ? String(step.step.kind) : "?";
      lines.push("- " + (step.ok ? "ok" : "FAILED") + " — " + kind + " (" + step.durationMs + "ms): " + step.detail);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function writeReport(outDir: string, results: ScenarioResult[], runId: string): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, runId + ".json");
  const markdown = join(outDir, runId + ".md");
  writeFileSync(json, JSON.stringify(results, null, 2) + "\n");
  writeFileSync(markdown, renderMarkdown(results) + "\n");
  return { json, markdown };
}
