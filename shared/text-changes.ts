/** What changed between a document and its edited version, sentence by sentence, with the words inside each changed
 * sentence. One implementation for the chat's "What changed" view and the bots' `what_changed` tool, so the two always
 * report the same counts. Pure and synchronous: callers run it in a worker, never on a server's event loop or the UI
 * thread. Every step has a work bound; a part too costly to align closely is still reported in full, sentence by
 * sentence (`coarse`), never left out. */

export const TEXT_CHANGES_MAX_CHARS = 4 * 1024 * 1024;
const UNIT_MAX_CHARS = 800;
const GAP_CELLS = 1_000_000;
const WORK_BUDGET = 60_000_000;
const PAIR_CELLS = 40_000;
const WORD_CELLS = 250_000;
const MAX_DEPTH = 64;
const SIMILAR = 0.4;

export interface TextChangeCounts { changed: number; added: number; removed: number; moved: number; unchanged: number }
export type WordPart = { op: "same" | "add" | "del"; text: string };
/** `para`: the paragraph (1-based) of the edited text it sits in; `beforePara`: the original's. */
export type ChangeSegment =
  | { kind: "same"; para: number; text: string }
  | { kind: "changed"; para: number; beforePara: number; before: string; after: string; parts: WordPart[]; minor: boolean }
  | { kind: "added"; para: number; text: string }
  | { kind: "removed"; para: number; beforePara: number; text: string }
  | { kind: "moved"; para: number; beforePara: number; text: string };
export interface TextChanges {
  counts: TextChangeCounts;
  segments: ChangeSegment[];
  /** Some stretch was too different to align closely: its sentences are reported as removed and added. */
  coarse: boolean;
  /** Work units spent, for the bounds tests. */
  work: number;
}
export type TextComparison = ({ ok: true } & TextChanges) | { ok: false; reason: "too_large" };

interface Unit { text: string; key: string; loose: string; para: number; words?: Set<string> }
type Op = { op: "eq"; a: number; b: number } | { op: "del"; a: number } | { op: "ins"; b: number };

let sentences: Intl.Segmenter | undefined;
let words: Intl.Segmenter | undefined;
const sentenceSegmenter = () => (sentences ??= new Intl.Segmenter("en", { granularity: "sentence" }));
const wordSegmenter = () => (words ??= new Intl.Segmenter("en", { granularity: "word" }));

/** Byte order mark, CRLF and Unicode composition never count as changes. */
export function normalizeText(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").normalize("NFC");
}

const keyOf = (text: string) => text.replace(/\s+/g, " ").trim();
const looseOf = (key: string) => key.toLowerCase().replace(/[\p{P}\p{S}]+/gu, "").replace(/\s+/g, " ").trim();

function pushUnit(units: Unit[], text: string, para: number): void {
  while (text.length > UNIT_MAX_CHARS) {
    let cut = text.lastIndexOf(" ", UNIT_MAX_CHARS - 1) + 1;
    if (cut < UNIT_MAX_CHARS / 2) cut = UNIT_MAX_CHARS;
    if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? "")) cut -= 1;
    pushPiece(units, text.slice(0, cut), para);
    text = text.slice(cut);
  }
  pushPiece(units, text, para);
}

function pushPiece(units: Unit[], text: string, para: number): void {
  const key = keyOf(text);
  if (!key) {
    if (units.length && units[units.length - 1]!.para === para) units[units.length - 1]!.text += text;
    return;
  }
  units.push({ text, key, loose: looseOf(key), para });
}

/** Paragraphs are blocks between blank lines. A line break followed by a lower-case letter is a wrapped sentence, so
 * re-wrapping a paragraph changes nothing; any other line (dialogue, a list item) starts a new sentence. */
export function splitSentences(text: string): Unit[] {
  const units: Unit[] = [];
  let para = 0;
  for (const block of text.split(/\n[\t ]*\n\s*/)) {
    if (!block.trim()) continue;
    para += 1;
    const prepared = block.replace(/\n(?=[\t ]*\p{Ll})/gu, " ");
    for (const { index, segment } of sentenceSegmenter().segment(prepared)) pushUnit(units, block.slice(index, index + segment.length), para);
  }
  return units;
}

function wordSet(unit: Unit): Set<string> {
  if (!unit.words) {
    unit.words = new Set();
    for (const part of wordSegmenter().segment(unit.loose)) if (part.isWordLike) unit.words.add(part.segment);
  }
  return unit.words;
}

function similarity(a: Unit, b: Unit): number {
  const left = wordSet(a), right = wordSet(b);
  if (!left.size || !right.size) return a.loose === b.loose ? 1 : 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

class Aligner {
  work = 0;
  coarse = false;
  readonly out: Op[] = [];
  private readonly a: readonly string[];
  private readonly b: readonly string[];
  constructor(a: readonly string[], b: readonly string[]) {
    this.a = a;
    this.b = b;
  }

  run(a0: number, a1: number, b0: number, b1: number, depth: number): void {
    const { a, b, out } = this;
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push({ op: "eq", a: a0++, b: b0++ });
    let tail = 0;
    while (a1 - tail > a0 && b1 - tail > b0 && a[a1 - 1 - tail] === b[b1 - 1 - tail]) tail += 1;
    this.middle(a0, a1 - tail, b0, b1 - tail, depth);
    for (let i = tail; i > 0; i--) out.push({ op: "eq", a: a1 - i, b: b1 - i });
  }

  private middle(a0: number, a1: number, b0: number, b1: number, depth: number): void {
    const { out } = this;
    this.work += a1 - a0 + b1 - b0;
    if (a0 === a1 || b0 === b1) {
      for (let i = a0; i < a1; i++) out.push({ op: "del", a: i });
      for (let j = b0; j < b1; j++) out.push({ op: "ins", b: j });
      return;
    }
    const anchors = depth < MAX_DEPTH ? this.anchors(a0, a1, b0, b1) : [];
    if (anchors.length) {
      let ai = a0, bj = b0;
      for (const [i, j] of anchors) {
        this.run(ai, i, bj, j, depth + 1);
        out.push({ op: "eq", a: i, b: j });
        ai = i + 1;
        bj = j + 1;
      }
      this.run(ai, a1, bj, b1, depth + 1);
      return;
    }
    const cells = (a1 - a0) * (b1 - b0);
    if (cells <= GAP_CELLS && this.work + cells <= WORK_BUDGET) return this.lcs(a0, a1, b0, b1);
    this.coarse = true;
    for (let i = a0; i < a1; i++) out.push({ op: "del", a: i });
    for (let j = b0; j < b1; j++) out.push({ op: "ins", b: j });
  }

  /** Sentences that occur exactly once on each side, kept in an order both sides agree on (patience diff). */
  private anchors(a0: number, a1: number, b0: number, b1: number): Array<[number, number]> {
    const seen = new Map<string, { a: number; na: number; b: number; nb: number }>();
    for (let i = a0; i < a1; i++) {
      const entry = seen.get(this.a[i]!);
      if (entry) entry.na += 1;
      else seen.set(this.a[i]!, { a: i, na: 1, b: -1, nb: 0 });
    }
    for (let j = b0; j < b1; j++) {
      const entry = seen.get(this.b[j]!);
      if (entry) { entry.nb += 1; entry.b = j; }
    }
    const pairs: Array<[number, number]> = [];
    for (const entry of seen.values()) if (entry.na === 1 && entry.nb === 1) pairs.push([entry.a, entry.b]);
    pairs.sort((x, y) => x[0] - y[0]);
    this.work += pairs.length * 2;
    const tops: number[] = [], back = new Int32Array(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
      let lo = 0, hi = tops.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pairs[tops[mid]!]![1] < pairs[k]![1]) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) back[k] = tops[lo - 1]!;
      tops[lo] = k;
    }
    const chain: Array<[number, number]> = [];
    for (let k = tops.length ? tops[tops.length - 1]! : -1; k >= 0; k = back[k]!) chain.push(pairs[k]!);
    return chain.reverse();
  }

  private lcs(a0: number, a1: number, b0: number, b1: number): void {
    const { a, b, out } = this;
    const n = a1 - a0, m = b1 - b0, width = m + 1;
    this.work += n * m;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[a0 + i] === b[b0 + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[a0 + i] === b[b0 + j]) out.push({ op: "eq", a: a0 + i++, b: b0 + j++ });
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) out.push({ op: "del", a: a0 + i++ });
      else out.push({ op: "ins", b: b0 + j++ });
    }
    while (i < n) out.push({ op: "del", a: a0 + i++ });
    while (j < m) out.push({ op: "ins", b: b0 + j++ });
  }
}

/** The words inside one changed sentence: spaces and punctuation are their own tokens, so a changed comma shows alone. */
export function wordParts(before: string, after: string): WordPart[] {
  const split = (text: string) => Array.from(wordSegmenter().segment(text), (part) => part.segment);
  const x = split(before), y = split(after);
  const same = (p: string, q: string) => p === q || (!p.trim() && !q.trim());
  const parts: WordPart[] = [];
  const push = (op: WordPart["op"], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.op === op) last.text += text;
    else parts.push({ op, text });
  };
  const n = x.length, m = y.length;
  if (n * m > WORD_CELLS) return [{ op: "del", text: before }, { op: "add", text: after }];
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = same(x[i]!, y[j]!) ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (same(x[i]!, y[j]!)) { push("same", y[j]!); i++; j++; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) push("del", x[i++]!);
    else push("add", y[j++]!);
  }
  while (i < n) push("del", x[i++]!);
  while (j < m) push("add", y[j++]!);
  return joinedRuns(parts);
}

/** Changes separated only by spaces read as one: "[-The train was late-]{+Blame the train+}", not word by word. */
function joinedRuns(parts: WordPart[]): WordPart[] {
  const out: WordPart[] = [];
  for (let k = 0; k < parts.length;) {
    if (parts[k]!.op === "same") { out.push(parts[k++]!); continue; }
    let before = "", after = "", end = k;
    for (let at = k; at < parts.length; at++) {
      const part = parts[at]!;
      if (part.op === "same" && (part.text.trim() || parts[at + 1]?.op === "same" || at + 1 === parts.length)) break;
      if (part.op !== "add") before += part.text;
      if (part.op !== "del") after += part.text;
      end = at + 1;
    }
    if (before) out.push({ op: "del", text: before });
    if (after) out.push({ op: "add", text: after });
    k = end;
  }
  return out;
}

type Step = { kind: "removed"; a: number } | { kind: "added"; b: number } | { kind: "changed"; a: number; b: number };

/** Pairs a hunk's removed and added sentences into changed ones where they share enough words, in order. */
function pairHunk(dels: number[], inss: number[], A: Unit[], B: Unit[], tally: { work: number }): Step[] {
  const n = dels.length, m = inss.length, steps: Step[] = [];
  if (!n || !m) return [...dels.map((a) => ({ kind: "removed" as const, a })), ...inss.map((b) => ({ kind: "added" as const, b }))];
  const sim = (i: number, j: number) => similarity(A[dels[i]!]!, B[inss[j]!]!);
  if (n * m <= PAIR_CELLS) {
    tally.work += n * m;
    const width = m + 1, score = new Float64Array((n + 1) * width);
    const scores = new Float64Array(n * m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) scores[i * m + j] = sim(i, j);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const s = scores[i * m + j]!;
        score[i * width + j] = Math.max(s >= SIMILAR ? s + score[(i + 1) * width + j + 1]! : 0, score[(i + 1) * width + j]!, score[i * width + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      const s = scores[i * m + j]!;
      if (s >= SIMILAR && score[i * width + j] === s + score[(i + 1) * width + j + 1]!) steps.push({ kind: "changed", a: dels[i++]!, b: inss[j++]! });
      else if (score[(i + 1) * width + j]! >= score[i * width + j + 1]!) steps.push({ kind: "removed", a: dels[i++]! });
      else steps.push({ kind: "added", b: inss[j++]! });
    }
    while (i < n) steps.push({ kind: "removed", a: dels[i++]! });
    while (j < m) steps.push({ kind: "added", b: inss[j++]! });
    return steps;
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    tally.work += 2;
    if (sim(i, j) >= SIMILAR) steps.push({ kind: "changed", a: dels[i++]!, b: inss[j++]! });
    else if (j + 1 < m && sim(i, j + 1) >= SIMILAR) steps.push({ kind: "added", b: inss[j++]! });
    else steps.push({ kind: "removed", a: dels[i++]! });
  }
  while (i < n) steps.push({ kind: "removed", a: dels[i++]! });
  while (j < m) steps.push({ kind: "added", b: inss[j++]! });
  return steps;
}

export function compareTexts(original: string, edited: string): TextComparison {
  if (original.length > TEXT_CHANGES_MAX_CHARS || edited.length > TEXT_CHANGES_MAX_CHARS) return { ok: false, reason: "too_large" };
  const A = splitSentences(normalizeText(original)), B = splitSentences(normalizeText(edited));
  const aligner = new Aligner(A.map((unit) => unit.key), B.map((unit) => unit.key));
  aligner.run(0, A.length, 0, B.length, 0);
  const ops = aligner.out;
  const tally = { work: aligner.work + A.length + B.length };

  // A sentence removed in one place and added in another moved: word for word, or with only punctuation or case changed.
  const movedFrom = new Map<number, { a: number; exact: boolean }>(), movedAway = new Set<number>();
  for (const field of ["key", "loose"] as const) {
    const removed = new Map<string, number[]>();
    for (const op of ops) {
      if (op.op !== "del" || movedAway.has(op.a)) continue;
      const list = removed.get(A[op.a]![field]);
      if (list) list.push(op.a);
      else removed.set(A[op.a]![field], [op.a]);
    }
    for (const op of ops) {
      if (op.op !== "ins" || movedFrom.has(op.b)) continue;
      const from = removed.get(B[op.b]![field])?.shift();
      if (from === undefined) continue;
      movedFrom.set(op.b, { a: from, exact: field === "key" });
      movedAway.add(from);
    }
  }

  const counts: TextChangeCounts = { changed: 0, added: 0, removed: 0, moved: 0, unchanged: 0 };
  const segments: ChangeSegment[] = [];
  const changedSegment = (before: Unit, after: Unit): ChangeSegment => {
    tally.work += before.text.length + after.text.length;
    return { kind: "changed", para: after.para, beforePara: before.para, before: before.text, after: after.text, parts: wordParts(before.text, after.text), minor: before.loose === after.loose };
  };
  const paraAt = (b: number) => B[Math.min(b, B.length - 1)]?.para ?? 1;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.op === "eq") {
      counts.unchanged += 1;
      segments.push({ kind: "same", para: B[op.b]!.para, text: B[op.b]!.text });
      k += 1;
      continue;
    }
    const dels: number[] = [], inss: number[] = [], moved: number[] = [];
    let nextB = B.length;
    for (; k < ops.length && ops[k]!.op !== "eq"; k++) {
      const step = ops[k]!;
      if (step.op === "del") { if (!movedAway.has(step.a)) dels.push(step.a); }
      else if (step.op === "ins") (movedFrom.has(step.b) ? moved : inss).push(step.b);
    }
    if (k < ops.length) nextB = (ops[k] as { b: number }).b;
    const queue = [...moved];
    const flush = (until: number) => {
      while (queue.length && queue[0]! < until) {
        const b = queue.shift()!, from = movedFrom.get(b)!;
        if (from.exact) {
          counts.moved += 1;
          segments.push({ kind: "moved", para: B[b]!.para, beforePara: A[from.a]!.para, text: B[b]!.text });
        } else {
          counts.changed += 1;
          segments.push(changedSegment(A[from.a]!, B[b]!));
        }
      }
    };
    for (const step of pairHunk(dels, inss, A, B, tally)) {
      if (step.kind === "removed") {
        counts.removed += 1;
        const at = inss.find((b) => b >= 0) ?? nextB;
        segments.push({ kind: "removed", para: paraAt(at), beforePara: A[step.a]!.para, text: A[step.a]!.text });
        continue;
      }
      flush(step.b);
      if (step.kind === "added") {
        counts.added += 1;
        segments.push({ kind: "added", para: B[step.b]!.para, text: B[step.b]!.text });
      } else {
        counts.changed += 1;
        segments.push(changedSegment(A[step.a]!, B[step.b]!));
      }
    }
    flush(Infinity);
  }
  return { ok: true, counts, segments, coarse: aligner.coarse, work: tally.work };
}

export const changeCount = (counts: TextChangeCounts) => counts.changed + counts.added + counts.removed + counts.moved;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** The `what_changed` tool's answer: a JSON line of counts, then one numbered line per change in reading order, words
 * marked `[-removed-]{+added+}`. A page never drops a change silently: its last line says how to list the rest. */
export function formatTextChanges(result: TextChanges, options: { start?: number; limit?: number; maxChars?: number } = {}): string {
  const start = Math.max(1, Math.floor(options.start ?? 1)), limit = Math.max(1, options.limit ?? 150), maxChars = options.maxChars ?? 20_000;
  const head = JSON.stringify({ ...result.counts, ...(result.coarse ? { coarse: true } : {}) });
  const changes = result.segments.filter((segment) => segment.kind !== "same");
  if (!changes.length) return `${head}\nNo changes: the two texts say the same thing, sentence for sentence.`;
  const lines = [head];
  let used = head.length, shown = 0;
  for (let index = start - 1; index < changes.length && shown < limit; index++) {
    const change = changes[index]!;
    const line = change.kind === "changed"
      ? `${index + 1}. ${change.minor ? "changed (punctuation or case only)" : "changed"}, paragraph ${change.para}: ${clip(change.parts.map((part) => part.op === "same" ? part.text : part.op === "del" ? `[-${part.text}-]` : `{+${part.text}+}`).join(""), 600)}`
      : change.kind === "added" ? `${index + 1}. added, paragraph ${change.para}: {+${clip(change.text, 500)}+}`
        : change.kind === "removed" ? `${index + 1}. removed, was paragraph ${change.beforePara} of the original: [-${clip(change.text, 500)}-]`
          : `${index + 1}. moved, from paragraph ${change.beforePara} to paragraph ${change.para}: ${clip(change.text, 500)}`;
    if (shown && used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const next = start + shown;
  if (next <= changes.length) lines.push(`${changes.length - next + 1} more not listed here; the counts above are complete. Call again with start: ${next} for the rest.`);
  if (result.coarse) lines.push("Some long stretches differed too much to match sentence by sentence; their sentences are listed as removed and added.");
  return lines.join("\n");
}
