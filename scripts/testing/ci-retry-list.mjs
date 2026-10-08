// The known-flaky list (ci-retry-list.json) and how a test is matched to it.
// Shared by the vitest runner (ci-retry-runner.ts) and the job-summary step
// (ci-retry-summary.mjs). docs/ci.md, "Flaky tests".
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Retries a listed test gets in CI: three attempts in all. */
export const CI_RETRIES = 2;

/** @typedef {{ file: string, test: string, owner: string, reason: string, since: string }} RetryEntry */

/** The list; OMB_VITEST_RETRY_LIST points elsewhere only for this mechanism's own tests.
 * @returns {RetryEntry[]} */
export function loadRetryList(env = process.env) {
  const path = env.OMB_VITEST_RETRY_LIST || DEFAULT_LIST;
  return JSON.parse(readFileSync(path, "utf8")).tests;
}

/** A plain path, never `new URL(…)`: in a jsdom or happy-dom test file the
 * global URL is the DOM's, and fs refuses its URL objects ("The URL must be of
 * scheme file"), which failed every vitest job that ran such a file in CI. */
const DEFAULT_LIST = join(dirname(fileURLToPath(import.meta.url)), "ci-retry-list.json");

/** CI sets CI=true; a developer's run never retries. */
export function retriesInCi(env = process.env) {
  return /^(1|true)$/i.test(env.CI ?? "");
}

/** A test's file relative to the vitest root (forward slashes) and its full
 * name: enclosing describe blocks and the test, joined with " > ".
 * @param {string} root
 * @param {{ name: string, file: { filepath: string }, suite?: { name: string, suite?: unknown, filepath?: string } }} task */
export function testIdentity(root, task) {
  const names = [];
  for (let node = task; node && !("filepath" in node); node = node.suite) names.unshift(node.name);
  return { file: relative(root, task.file.filepath).split(sep).join("/"), test: names.join(" > ") };
}

/** @param {RetryEntry[]} list @param {{ file: string, test: string }} identity */
export function findRetryEntry(list, identity) {
  return list.find((entry) => entry.file === identity.file && entry.test === identity.test);
}
