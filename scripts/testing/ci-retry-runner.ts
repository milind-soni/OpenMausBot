// vitest's own runner plus CI-only retries for the known flaky tests in
// ci-retry-list.json; a test that needed a retry is logged to
// OMB_VITEST_RETRY_LOG for the job summary. Retries are bounded per file: once
// a listed test fails every attempt, the file's later listed tests get none.
import { appendFileSync } from "node:fs";
import type { RunnerTask, RunnerTestCase } from "vitest";
import { VitestTestRunner } from "vitest/runners";
import { CI_RETRIES, findRetryEntry, loadRetryList, retriesInCi, testIdentity } from "./ci-retry-list.mjs";

// Fails open: the list is a CI convenience, and a list that cannot be read
// must never fail a run whose tests all passed.
const list = retriesInCi() ? safeRetryList() : [];

function safeRetryList() {
  try {
    return loadRetryList();
  } catch (error) {
    const message = `the flaky-test list could not be read, so no test is retried: ${String(error)}`;
    console.warn(`ci-retry-runner: ${message}`);
    // The summary step reports it, so a broken list is seen, not just survived.
    const log = process.env.OMB_VITEST_RETRY_LOG;
    if (log) {
      try { appendFileSync(log, `${JSON.stringify({ listError: message })}\n`); } catch { /* the warning above remains */ }
    }
    return [];
  }
}

export default class CiRetryRunner extends VitestTestRunner {
  /** Files where a listed test failed every attempt: no more retries there. */
  private readonly exhausted = new Set<string>();

  override onBeforeRunTask(test: RunnerTestCase) {
    if (list.length > 0 && !this.exhausted.has(test.file.filepath) && findRetryEntry(list, testIdentity(this.config.root, test))) test.retry = CI_RETRIES;
    return super.onBeforeRunTask(test);
  }

  override onAfterRunTask(test: RunnerTask) {
    super.onAfterRunTask(test);
    const retries = test.result?.retryCount ?? 0;
    if (retries > 0 && test.result?.state === "fail") this.exhausted.add(test.file.filepath);
    const log = process.env.OMB_VITEST_RETRY_LOG;
    if (retries === 0 || !log || test.type !== "test") return;
    const line = { ...testIdentity(this.config.root, test), retries, state: test.result?.state, platform: process.platform };
    try {
      appendFileSync(log, `${JSON.stringify(line)}\n`);
    } catch (error) {
      console.warn(`ci-retry-runner: could not record a retry in ${log}: ${String(error)}`);
    }
  }
}
