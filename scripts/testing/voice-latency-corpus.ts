#!/usr/bin/env node
// Builds the adversarial voice-latency corpus fixture: reply shapes chosen
// to stress the speak pipeline. Every number in the manifest comes from
// running the real toUtterances, never from estimation.
// Deterministic: same code, same bytes, so both sides of the before/after
// measurement speak the identical corpus (identified by the fixture's sha256).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toUtterances } from "../../server/tts/speech-text.ts";

export const CORPUS_VERSION = 1;
export const GAP_THRESHOLD_MS = 200;
/** Delta replay cadence: chunkChars every intervalMs (160 chars/s), replayed
 * by the fake engine's stream knob. Identical on both sides of the run. */
export const CADENCE = { chunkChars: 24, intervalMs: 150 } as const;
/** Modeled synthesis timing for the record stub: synthesis takes RTF × the
 * modeled clip duration (audioMsPerChar per text char). Pins the worst
 * case: 319 chars × 0.5 × 70 ms = 11.2 s of synthesis. firstByteMs is
 * the modeled provider TTFT for streamed delivery: a protocol pin,
 * not a measurement. */
export const SYNTHESIS = { rtf: 0.5, audioMsPerChar: 70, firstByteMs: 300 } as const;

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = join(HERE, "fixtures", "voice-latency", "corpus.json");
export const MANIFEST_PATH = join(HERE, "fixtures", "voice-latency", "manifest.json");
/** git's core.autocrlf rewrites checked-out text to CRLF on Windows; fixture
 * bytes and ids are defined over LF, so every read normalizes back to LF. */
export function readLfText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

export function corpusFixtureId(corpusText: string): string {
  return createHash("sha256").update(corpusText.replace(/\r\n/g, "\n")).digest("hex");
}

export interface CorpusReply {
  id: string;
  shape: string;
  text: string;
}

/** Natural words by length, for exact-length fills. */
const WORDS: Record<number, readonly string[]> = {
  2: ["it", "on"],
  3: ["the", "all", "one"],
  4: ["then", "each", "once"],
  5: ["after", "every", "still"],
  6: ["before", "during", "intact"],
  7: ["morning", "further", "settled"],
  8: ["together", "graceful", "watchful"],
  9: ["automatic", "certainly", "presently"],
  10: ["everything", "afterwards", "gracefully"],
  11: ["immediately", "efficiently", "temporarily"],
  12: ["consistently", "considerably", "straightaway"],
};

function wordOfLength(length: number, salt: number): string | null {
  return WORDS[length]?.[salt % WORDS[length]!.length] ?? null;
}

/** Words joined by single spaces, exactly `target` chars: the lead phrase,
 * then greedy bank words, ending on a word that lands the length exactly. */
function exactRun(target: number, lead: string): string {
  const words = lead.split(" ");
  let len = lead.length;
  for (let salt = 0; len < target; salt += 1) {
    const longest = Math.min(12, target - len - 1);
    let pick = "";
    for (let length = longest; length >= 2; length -= 1) {
      const candidate = wordOfLength(length, salt);
      // A word is usable when it lands exactly, or leaves room for another word.
      if (candidate && (len + 1 + length === target || target - (len + 1 + length) >= 3)) {
        pick = candidate;
        break;
      }
    }
    if (!pick) throw new Error(`exactRun stuck at ${len}/${target}`);
    words.push(pick);
    len += 1 + pick.length;
  }
  if (len !== target) throw new Error(`exactRun landed at ${len}, wanted ${target}`);
  return words.join(" ");
}

/** One unpunctuated sentence-shaped run of exactly `target` chars. */
function unpunctuatedRun(target: number, lead: string): string {
  const text = exactRun(target, lead);
  const blocks = toUtterances(text);
  if (blocks.length !== 1 || blocks[0]!.length !== target) {
    throw new Error(`unpunctuated run: wanted one ${target}-char block, got ${blocks.map((b) => b.length).join(",")}`);
  }
  return text;
}

// Each item must stay under 12 flattened chars (code plus the period a
// newline becomes), or it stops merging and the reply is no longer one block.
const CODE_ITEMS = ["npm i", "pnpm i", "go run", "cargo run", "docker cp", "git pull", "make all"];

/** A code-list reply whose only block is exactly `target` chars: short inline
 * code items (kept verbatim by the splitter) merge into one block, so header
 * filler words tune the total. Each filler word adds its length plus one
 * space, so the count and a final exact-length word solve the target. */
function codeList(target: number): string {
  const itemsText = CODE_ITEMS.map((item) => `- \`${item}\``).join("\n");
  const base = toUtterances(`Install these first:\n${itemsText}`);
  if (base.length !== 1) throw new Error(`code list base split into ${base.length} blocks`);
  // base + 13 per 12-char filler word + (1 + len) for the final word = target
  const debt = target - base[0]!.length;
  const fillers = Math.floor((debt - 3) / 13);
  const finalWord = wordOfLength(debt - 13 * fillers - 1, fillers);
  if (!finalWord) throw new Error(`code list cannot reach ${target}: debt ${debt}, fillers ${fillers}`);
  const header = ["Install these first",
    ...Array.from({ length: fillers }, (_, at) => wordOfLength(12, at)!),
    finalWord].join(" ");
  const text = `${header}:\n${itemsText}`;
  const blocks = toUtterances(text);
  if (blocks.length !== 1 || blocks[0]!.length !== target) {
    throw new Error(`code list: wanted one ${target}-char block, got ${blocks.map((b) => b.length).join(",")}`);
  }
  return text;
}

const EM_DASH_SEGMENTS = [
  "Setup checks", "config reload", "secret rotation", "edge routing",
  "retry budgets", "queue draining", "cache warming", "health probes",
];

/** One line of em-dash separated segments, exactly `target` chars; em dashes
 * are not sentence boundaries, so it stays a single block. The final segment
 * is filled to the exact remaining length with bank words. */
function emDashList(target: number): string {
  const head = EM_DASH_SEGMENTS.join(" — ");
  const remaining = target - (head.length + 3);
  const firstTailWord = Object.values(WORDS).flat().find((word) => word.length + 2 <= remaining);
  if (remaining < 5 || !firstTailWord) throw new Error(`em-dash list cannot reach ${target}: remaining ${remaining}`);
  const text = `${head} — ${exactRun(remaining, firstTailWord)}`;
  const blocks = toUtterances(text);
  if (blocks.length !== 1 || blocks[0]!.length !== target) {
    throw new Error(`em-dash list: wanted one ${target}-char block, got ${blocks.map((b) => b.length).join(",")}`);
  }
  return text;
}

const STACCATO_PIECES: Record<number, readonly string[]> = {
  3: ["Go."],
  4: ["Now.", "Say."],
  5: ["Sure.", "Fine."],
  6: ["On it."],
  7: ["Got it.", "Pinged."],
  8: ["No rush.", "Ping me."],
  9: ["Any time.", "I'm here.", "All good."],
  10: ["Back soon.", "It's fine."],
  11: ["Right away.", "Any minute."],
};

/** Sentences under 12 chars merge unboundedly: a staccato reply that is one
 * block of exactly `target` chars. Deterministic search over piece banks. */
function staccato(target: number): string {
  const lengths = Object.keys(STACCATO_PIECES).map(Number).sort((a, b) => b - a);
  const search = (built: string[], len: number): string | null => {
    if (len === target) return built.join(" ");
    for (const length of lengths) {
      const next = len + (built.length ? 1 : 0) + length;
      if (next > target || target - next === 1 || target - next === 2) continue;
      const piece = STACCATO_PIECES[length]![built.length % STACCATO_PIECES[length]!.length]!;
      const found = search([...built, piece], next);
      if (found) return found;
    }
    return null;
  };
  const text = search([], 0);
  if (!text) throw new Error(`staccato cannot reach ${target}`);
  const blocks = toUtterances(text);
  if (blocks.length !== 1 || blocks[0]!.length !== target) {
    throw new Error(`staccato: wanted one ${target}-char block, got ${blocks.map((b) => b.length).join(",")}`);
  }
  return text;
}

const UNPUNCTUATED_319 = unpunctuatedRun(319, "the deploy finished and everything looks stable");
const CODE_LIST_211 = codeList(211);
const EM_DASH_153 = emDashList(153);
const TYPICAL_26 = "Sure, tomorrow works fine. I will bring the annotated numbers to the review and keep the diff short so nobody has to scroll. Let me know if the slot moves.";
const STACCATO_92 = staccato(92);
const MIXED_LATE_319 = [
  "Here is where the migration stands after this week's work.",
  "The accounts service now writes both schemas side by side.",
  "Backfills are at ninety two percent and holding steady overnight.",
  "The read path cut over on Tuesday with no error-rate movement.",
  "Remaining work is the cleanup of the old table and its indexes.",
  "I will keep the dashboard current so you can watch the tail drain.",
  "Nothing here needs a decision from you until the cutover vote.",
  unpunctuatedRun(319, "the migration is now stable enough that we can stop the dual writes whenever you are ready"),
].join(" ");

// ---- Typical replies: natural assistant prose, 40-79 char sentences ----

const TYPICAL_SENTENCES = [
  "The nightly build came back clean tonight.",
  "The nightly build came back clean, so the release candidate ships tomorrow.",
  "I moved the retry logic into the shared client.",
  "I moved the retry logic into the shared client and added a regression test.",
  "Your summary landed and two people approved it.",
  "Your summary landed in the thread, and two people replied with approvals.",
  "The cache spike was a cold start, not a regression.",
  "The cache miss spike was a cold start after the deploy, not a regression.",
  "I drafted the migration notes for the runbook.",
  "I drafted the migration notes and linked them from the runbook index page.",
  "Search latency is back under the agreed budget.",
  "Search latency is back under the budget we agreed on in last month's review.",
  "The flaky test now uses the injected timer.",
  "The flaky test was a clock assumption; it now uses the injected timer.",
  "We keep the old endpoint one more release.",
  "We should keep the old endpoint around for one more release before removal.",
  "I checked the logs and found nothing past the alert.",
  "I checked the incident logs and found nothing past the first alert window.",
  "The dashboard splits build time from deploy time.",
  "The dashboard now separates build time from deploy time, as you requested.",
  "Both dependency advisories are patched in this build.",
  "Two dependencies had security advisories, and both are patched in this build.",
  "Queue depth settles within a minute of each batch.",
  "The queue depth settles within a minute of each batch finishing overnight.",
  "The feature flag stays on for staging only for now.",
  "I left the feature flag on for the staging workspace only, for now.",
  "Review notes are attached with owners per action.",
  "Notes from the review are attached, with an owner next to each action.",
  "The script exits non-zero on a checksum mismatch.",
  "The script now exits non-zero when the backup checksum does not match.",
  "Region failover took forty seconds in the drill.",
  "Region failover took forty seconds in the drill, under the agreed target.",
  "I rebased the branch and resolved the import move.",
  "I rebased the branch on the latest main and resolved the moved import path.",
  "Uploads skip re-encoding for already-right sizes.",
  "The upload path skips re-encoding for files already in the right size.",
  "One alert fired; it was the expected rotation.",
  "One alert fired during the window; it was the expected certificate rotation.",
  "The docs page shows the new limits and a note.",
  "The docs page shows the new limits and a short note about the change.",
  "Memory use is flat across a full day of traffic.",
  "Memory use stays flat across a full day of traffic with the pool enabled.",
  "Open items are grouped by owner for the standup.",
  "I grouped the open items by owner so the standup can go in a fixed order.",
  "The new path is faster on every shape we tested.",
  "The comparison shows the new path is faster on every shape we tested.",
  "We can drop the shim once callers use the typed API.",
  "We can drop the shim once the last caller moves to the typed API.",
  "The audit export names the actor per change.",
  "The audit export now includes the actor for every permission change.",
  "Draft announcement copy is ready for your edits.",
  "Draft copy for the announcement is ready for your edits whenever you are.",
  "The warm pool cut cold starts under a second.",
  "The warm pool cut cold-start time to under a second for most requests.",
  "I verified the fix on a fresh profile too.",
  "I verified the fix on a fresh profile, not just on my own machine.",
  "The scheduler owns the schedule now, not cron.",
  "The old cron entries are gone; the scheduler owns the schedule now.",
  "Tail latency improved by a wide margin this week.",
  "Latency at the ninety-ninth percentile improved by a wide margin this week.",
];

const TYPICAL_MARKDOWN_SENTENCES = [
  "The **key finding** is that the error came from one mislabeled queue.",
  "Start with [the overview](https://example.test/overview) before the details.",
  "Run `npm install` once, then `pnpm build` from the repository root.",
];

/** Deterministic rotation: reply `index` takes sentences starting at index*3. */
function typicalReply(index: number, count: number): string {
  const parts: string[] = [];
  for (let at = 0; at < count; at += 1) {
    parts.push(TYPICAL_SENTENCES[(index * 3 + at) % TYPICAL_SENTENCES.length]!);
    if (at === 2 && index % 4 === 1) {
      parts.push(TYPICAL_MARKDOWN_SENTENCES[index % TYPICAL_MARKDOWN_SENTENCES.length]!);
    }
  }
  return parts.join(" ");
}

/** Adversarial shapes first (run order), then typical replies to reach the
 * pinned totals (~116 blocks, mean ~66 chars). */
export function buildCorpus(): CorpusReply[] {
  const replies: CorpusReply[] = [
    { id: "unpunctuated-run-319", shape: "unpunctuated-run", text: UNPUNCTUATED_319 },
    { id: "code-list-211", shape: "code-list", text: CODE_LIST_211 },
    { id: "em-dash-list-153", shape: "em-dash-list", text: EM_DASH_153 },
    { id: "typical-medium-26", shape: "typical-medium", text: TYPICAL_26 },
    { id: "staccato-92", shape: "staccato", text: STACCATO_92 },
    { id: "mixed-late-319", shape: "mixed-late-block", text: MIXED_LATE_319 },
  ];
  const counts = [5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 3];
  counts.forEach((count, index) => {
    replies.push({ id: `typical-${String(index + 1).padStart(2, "0")}`, shape: "typical", text: typicalReply(index, count) });
  });
  return replies;
}

export interface ReplyMeasurement {
  id: string;
  shape: string;
  rawChars: number;
  blocks: number;
  blockChars: number[];
  firstBlockChars: number;
  speakableChars: number;
}

export interface CorpusTotals {
  replies: number;
  blocks: number;
  meanBlockChars: number;
  blocks40to79: number;
  speakableChars: number;
}

export interface CorpusMeasurement {
  replies: ReplyMeasurement[];
  totals: CorpusTotals;
}

export function measureCorpus(replies: readonly CorpusReply[]): CorpusMeasurement {
  const measured = replies.map((reply) => {
    const blocks = toUtterances(reply.text);
    return {
      id: reply.id,
      shape: reply.shape,
      rawChars: [...reply.text].length,
      blocks: blocks.length,
      blockChars: blocks.map((block) => [...block].length),
      firstBlockChars: blocks[0]?.length ?? 0,
      speakableChars: blocks.reduce((sum, block) => sum + [...block].length, 0),
    };
  });
  const blocks = measured.reduce((sum, reply) => sum + reply.blocks, 0);
  const speakableChars = measured.reduce((sum, reply) => sum + reply.speakableChars, 0);
  return {
    replies: measured,
    totals: {
      replies: measured.length,
      blocks,
      meanBlockChars: blocks ? speakableChars / blocks : 0,
      blocks40to79: measured.reduce((sum, reply) => sum + reply.blockChars.filter((n) => n >= 40 && n <= 79).length, 0),
      speakableChars,
    },
  };
}

export function corpusJson(replies: readonly CorpusReply[]): string {
  return `${JSON.stringify({ version: CORPUS_VERSION, name: "voice-latency-corpus", replies }, null, 2)}\n`;
}

function pin(measured: ReplyMeasurement | undefined, id: string, check: (reply: ReplyMeasurement) => string | null): void {
  if (!measured) throw new Error(`${id}: missing from corpus`);
  const error = check(measured);
  if (error) throw new Error(`${id}: ${error}`);
}

function main(): void {
  const replies = buildCorpus();
  // The pins are the measured worst first blocks; fail the build
  // rather than committing a corpus that drifted from them.
  const byId = new Map(measureCorpus(replies).replies.map((reply) => [reply.id, reply]));
  pin(byId.get("unpunctuated-run-319"), "unpunctuated-run-319", (r) => (r.firstBlockChars === 319 ? null : `first block ${r.firstBlockChars}, pinned 319`));
  pin(byId.get("code-list-211"), "code-list-211", (r) => (r.firstBlockChars === 211 ? null : `first block ${r.firstBlockChars}, pinned 211`));
  pin(byId.get("em-dash-list-153"), "em-dash-list-153", (r) => (r.firstBlockChars === 153 ? null : `first block ${r.firstBlockChars}, pinned 153`));
  pin(byId.get("typical-medium-26"), "typical-medium-26", (r) => (r.firstBlockChars === 26 ? null : `first block ${r.firstBlockChars}, pinned 26`));
  pin(byId.get("staccato-92"), "staccato-92", (r) => (r.blocks === 1 && r.blockChars[0] === 92 ? null : `wanted one 92-char block, got ${r.blockChars.join(",")}`));
  pin(byId.get("mixed-late-319"), "mixed-late-319", (r) => (r.blockChars.at(-1) === 319 ? null : `last block ${r.blockChars.at(-1)}, pinned 319`));

  const canonical = corpusJson(replies);
  const corpusSha = corpusFixtureId(canonical);
  const { replies: measured, totals } = measureCorpus(replies);
  const manifest = `${JSON.stringify({
    corpusFixtureId: corpusSha,
    corpusPath: "scripts/testing/fixtures/voice-latency/corpus.json",
    generator: "scripts/testing/voice-latency-corpus.ts",
    splitter: { entry: "server/tts/speech-text.ts#toUtterances", minChars: 12, maxChars: 320 },
    cadence: CADENCE,
    gapThresholdMs: GAP_THRESHOLD_MS,
    synthesis: SYNTHESIS,
    totals,
    shapePins: {
      "unpunctuated-run-319": { firstBlockChars: 319 },
      "code-list-211": { firstBlockChars: 211 },
      "em-dash-list-153": { firstBlockChars: 153 },
      "typical-medium-26": { firstBlockChars: 26 },
      "staccato-92": { blocks: 1, blockChars: 92 },
      "mixed-late-319": { lastBlockChars: 319 },
    },
    replies: measured,
  }, null, 2)}\n`;
  mkdirSync(dirname(CORPUS_PATH), { recursive: true });
  writeFileSync(CORPUS_PATH, canonical);
  writeFileSync(MANIFEST_PATH, manifest);
  process.stdout.write(`${JSON.stringify({ corpusFixtureId: corpusSha, totals }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
