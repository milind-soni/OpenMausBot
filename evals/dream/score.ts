import { jsonPayload } from "../../server/memory-capture.ts";
import { parseDream, type DreamConversation, type DreamLine } from "../../server/memory-dream.ts";
import { foldForMatch, passageMatcher } from "../../server/memory-entries.ts";
import { checkDreamFacts } from "../../server/memory-fact-checks.ts";
import { contradictionCandidates } from "../../server/memory-tidy.ts";

/** One saved line matches when it contains any of these, ignoring case, width and invisible characters. */
export interface Expected {
  anyOf: string[];
}

export interface DreamCase {
  id: string;
  /** The dream behaviour this case pins, in plain words. */
  why: string;
  today: string;
  conversations: Array<{ title?: string; lines: DreamLine[] }>;
  /** MEMORY.md as the bot has it before the dream. */
  notebook: string;
  /** Passages the person asked their bots to forget; the case's own, never this machine's profile. */
  forgotten?: string[];
  expect: {
    learned: Expected[];
    outdated: Array<Expected & { line: number }>;
    /** No saved line may contain any of these, ignoring case, width, invisible characters and digits that stand for letters. */
    never: string[];
    /** Any saved line no expectation covers fails the case. */
    nothingElse?: boolean;
  };
}

export interface DreamScore {
  json: boolean;
  learned: string[];
  outdated: Array<{ line: number; now: string }>;
  /** Parsed entries the fact checks or the forgotten passages refused. */
  dropped: number;
  found: number;
  expected: number;
  /** Saved lines that no expectation covers: not wrong in themselves, for a judge to read. */
  unexpected: string[];
  violations: string[];
  pass: boolean;
}

export function dreamConversationsOf(testCase: Pick<DreamCase, "id" | "conversations">): DreamConversation[] {
  return testCase.conversations.map((conversation, i) => ({ threadId: `${testCase.id}-${i + 1}`, ...conversation }));
}

export function notebookOf(testCase: Pick<DreamCase, "notebook" | "today">) {
  return contradictionCandidates(testCase.notebook, testCase.today);
}

const plain = (text: string) => foldForMatch(text.replace(/\p{Cf}/gu, ""));
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
const unmasked = (text: string) => plain(text).replace(/[013457@$!]/g, (c) => LOOKALIKE[c]!);

const covers = (expected: Expected, text: string) => expected.anyOf.some((word) => plain(text).includes(plain(word)));
const forbids = (never: readonly string[], text: string) => never.some((word) => unmasked(text).includes(unmasked(word)));

/** Grades one model answer the way runDream would keep it, before anything is written. */
export function scoreDream(testCase: DreamCase, answer: string): DreamScore {
  const conversations = dreamConversationsOf(testCase);
  const notebook = notebookOf(testCase);
  const parsed = parseDream(answer, conversations.length, notebook.length);
  const forgotten = (testCase.forgotten ?? []).map(passageMatcher).filter((match): match is (text: string) => boolean => match !== null);
  const kept = (text: string, from: readonly number[], evidence: readonly string[] | undefined) =>
    checkDreamFacts(text, from, evidence, conversations) && !forgotten.some((matches) => matches(text));
  const learned = parsed.learned.filter((item) => kept(item.text, item.from, item.evidence)).map((item) => item.text);
  const outdated = parsed.outdated.filter((item) => kept(item.now, item.from, item.evidence)).map(({ line, now }) => ({ line, now }));
  const dropped = parsed.learned.length + parsed.outdated.length - learned.length - outdated.length;
  const foundLearned = testCase.expect.learned.filter((expected) => learned.some((text) => covers(expected, text))).length;
  const foundOutdated = testCase.expect.outdated.filter((expected) => outdated.some((item) => item.line === expected.line && covers(expected, item.now))).length;
  const saved = [...learned, ...outdated.map((item) => item.now)];
  const violations = saved.filter((text) => forbids(testCase.expect.never, text));
  const unexpected = [
    ...learned.filter((text) => !testCase.expect.learned.some((expected) => covers(expected, text))),
    ...outdated.filter((item) => !testCase.expect.outdated.some((expected) => expected.line === item.line && covers(expected, item.now))).map((item) => item.now),
  ];
  const json = jsonPayload(answer) !== null;
  const found = foundLearned + foundOutdated;
  const expected = testCase.expect.learned.length + testCase.expect.outdated.length;
  const pass = json && violations.length === 0 && found === expected && !(testCase.expect.nothingElse && unexpected.length > 0);
  return { json, learned, outdated, dropped, found, expected, unexpected, violations, pass };
}

export function summarize(rows: ReadonlyArray<{ score: DreamScore; costUsd?: number; ms?: number }>) {
  return {
    cases: rows.length,
    passed: rows.filter((row) => row.score.pass).length,
    found: rows.reduce((sum, row) => sum + row.score.found, 0),
    expected: rows.reduce((sum, row) => sum + row.score.expected, 0),
    violations: rows.reduce((sum, row) => sum + row.score.violations.length, 0),
    dropped: rows.reduce((sum, row) => sum + row.score.dropped, 0),
    invalidJson: rows.filter((row) => !row.score.json).length,
    costUsd: Number(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(4)),
    ms: rows.reduce((sum, row) => sum + (row.ms ?? 0), 0),
  };
}
