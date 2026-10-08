// Puts the known-flaky tests that needed a retry in this job's summary
// ($GITHUB_STEP_SUMMARY) and raises a warning annotation for each, so a flake
// that passed on a retry is still seen. Reads the lines ci-retry-runner.ts
// wrote to OMB_VITEST_RETRY_LOG; no log means no retries. docs/ci.md, "Flaky tests".
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRetryEntry, loadRetryList } from "./ci-retry-list.mjs";

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** @param {string} logText @param {import("./ci-retry-list.mjs").RetryEntry[]} list */
export function retrySummary(logText, list) {
  const lines = logText.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const listErrors = [...new Set(lines.filter((line) => typeof line.listError === "string").map((line) => line.listError))];
  const rows = lines.filter((line) => typeof line.listError !== "string");
  const errorAnnotations = listErrors.map((message) => `::warning title=${escapeProperty("Flaky-test list unreadable")}::${escapeData(message)}`);
  const errorMarkdown = listErrors.length ? ["### The flaky-test list could not be read", "", ...listErrors.map((message) => `- ${cell(message)}`), "", "No test was retried in this job.", ""].join("\n") : "";
  if (rows.length === 0) return { markdown: errorMarkdown, annotations: errorAnnotations };
  const markdown = [
    "### Flaky tests that needed a retry",
    "",
    "Listed in `scripts/testing/ci-retry-list.json`; fix the test, then delete its entry.",
    "",
    "| Test | Retries | Result | Owner | Why it is listed |",
    "|---|---|---|---|---|",
    ...rows.map((row) => {
      const entry = findRetryEntry(list, row);
      return `| \`${cell(row.file)}\` > ${cell(row.test)} | ${row.retries} | ${row.state === "pass" ? "passed on a retry" : "failed every attempt"} | ${cell(entry?.owner ?? "unlisted")} | ${cell(entry?.reason)} |`;
    }),
    "",
  ].join("\n");
  const annotations = rows.map((row) =>
    `::warning file=${escapeProperty(row.file)},title=${escapeProperty("Flaky test retried")}::${escapeData(`${row.test} needed ${row.retries} ${row.retries === 1 ? "retry" : "retries"} (${row.state === "pass" ? "passed" : "failed"}). Listed in scripts/testing/ci-retry-list.json.`)}`);
  return { markdown: errorMarkdown + markdown, annotations: [...errorAnnotations, ...annotations] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = process.env.OMB_VITEST_RETRY_LOG;
  const text = log && existsSync(log) ? readFileSync(log, "utf8") : "";
  const { markdown, annotations } = retrySummary(text, loadRetryList());
  for (const line of annotations) console.log(line);
  if (markdown && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(annotations.length ? `${annotations.length} listed flaky test(s) needed a retry.` : "No listed flaky test needed a retry.");
}
