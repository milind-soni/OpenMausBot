// How the new browser's v1 transcript is held to the agent-browser engine's golden. Event names, fields and types must
// match everywhere; per step, what a phone acts on must match: who controls, how many tabs and which is in front, the
// address, and that pictures keep coming. Values that differed between runs of the old engine (titles it reported as
// addresses, the order events arrived in, a step it failed) are not part of the contract.
import { readFileSync } from "node:fs";

import { BROWSER_WAITING } from "../../../browser-live.ts";
import { shape as fieldShape } from "./v1-session.ts";

interface Step {
  step: string;
  answer: unknown;
  events: string[];
  shapes: Record<string, unknown>;
  control?: Record<string, boolean>;
  tabs?: Array<{ title: string; url: string; active: boolean }>;
  url?: string;
  connected?: boolean;
  frameFormat?: string;
}

export const V1_GOLDEN = JSON.parse(readFileSync(new URL("./v1-golden.json", import.meta.url), "utf8")) as Step[];

/** Events of the contract the recorded session never met: the old engine says it waits while its browser is busy, the
 * new one while its browser starts. */
const UNRECORDED = new Map([BROWSER_WAITING].map(({ type, ...data }) => [type, JSON.stringify(fieldShape(data))]));

export function v1Differences(actual: Array<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  const expectedShapes = new Map<string, string>();
  for (const step of V1_GOLDEN) for (const [type, shape] of Object.entries(step.shapes)) expectedShapes.set(type, JSON.stringify(shape));
  const seenTypes = new Set<string>();
  for (const step of actual as unknown as Step[]) {
    for (const [type, shape] of Object.entries(step.shapes ?? {})) {
      seenTypes.add(type);
      const expected = expectedShapes.get(type) ?? UNRECORDED.get(type);
      if (expected === undefined) problems.push(`${step.step}: an event the v1 contract does not have: ${type}`);
      else if (expected !== JSON.stringify(shape)) problems.push(`${step.step}: ${type} carries ${JSON.stringify(shape)}, the contract ${expected}`);
    }
  }
  for (const type of expectedShapes.keys()) if (!seenTypes.has(type)) problems.push(`the session never sent ${type}`);
  for (const expected of V1_GOLDEN) {
    const got = (actual as unknown as Step[]).find((step) => step.step === expected.step);
    if (!got) { problems.push(`no step ${expected.step}`); continue; }
    if (failedInGolden(expected)) continue;
    const answer = expected.answer as Record<string, unknown> | string;
    if (JSON.stringify(answer) !== JSON.stringify(got.answer)) problems.push(`${expected.step}: answered ${JSON.stringify(got.answer)}, the contract ${JSON.stringify(answer)}`);
    problems.push(...shownDifferences(expected, got));
  }
  return problems;
}

/** A step the old engine failed when the golden was recorded holds nothing to the contract. */
function failedInGolden(step: Step): boolean {
  return typeof step.answer === "object" && step.answer !== null && "error" in step.answer;
}

/** What a phone acts on after one step: who controls, the tabs, the address, and that a picture came. */
function shownDifferences(expected: Step, got: Step): string[] {
  const problems: string[] = [];
  if (expected.control && JSON.stringify(expected.control) !== JSON.stringify(got.control)) problems.push(`${expected.step}: control ${JSON.stringify(got.control)}, expected ${JSON.stringify(expected.control)}`);
  if (expected.tabs) {
    const want = expected.tabs.map((tab) => `${tab.url}${tab.active ? "*" : ""}`).join(" ");
    const have = (got.tabs ?? []).map((tab) => `${tab.url}${tab.active ? "*" : ""}`).join(" ");
    if (want !== have) problems.push(`${expected.step}: tabs ${have}, expected ${want}`);
  }
  if (expected.url && expected.url !== got.url) problems.push(`${expected.step}: address ${String(got.url)}, expected ${expected.url}`);
  if (expected.frameFormat && got.frameFormat !== expected.frameFormat) problems.push(`${expected.step}: no ${expected.frameFormat} picture came`);
  return problems;
}

/** True once a normalized step shows a phone everything the golden's same step showed it. */
export function v1StepShown(step: Record<string, unknown>): boolean {
  const expected = V1_GOLDEN.find((candidate) => candidate.step === step.step);
  return !expected || failedInGolden(expected) || shownDifferences(expected, step as unknown as Step).length === 0;
}
