#!/usr/bin/env node
// First-block listing for the voice path's cap: runs the
// committed splitter with the first-block cap over the committed
// corpus and writes every reply's first-block char count. Offline and
// deterministic: no engine, no key, no audio, no timing.
import { cpus } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toUtterances, VOICE_FIRST_BLOCK_MAX_CHARS } from "../../server/tts/speech-text.ts";
import { corpusFixtureId, CORPUS_PATH, MANIFEST_PATH, readLfText } from "./voice-latency-corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(HERE, "fixtures", "voice-latency", "logs");
const LABEL = "firstblock";

interface CorpusReply {
  id: string;
  shape: string;
  text: string;
}

function main(): void {
  const corpusText = readLfText(CORPUS_PATH);
  const corpusSha = corpusFixtureId(corpusText);
  const manifest = JSON.parse(readLfText(MANIFEST_PATH)) as { corpusFixtureId: string };
  if (manifest.corpusFixtureId !== corpusSha) {
    throw new Error(`corpus fixture drift: manifest ${manifest.corpusFixtureId} != file ${corpusSha}`);
  }
  const corpus = JSON.parse(corpusText) as { replies: CorpusReply[] };

  // The same option /api/tts/prepare passes: the voice path's cap.
  const replies = corpus.replies.map((reply) => {
    const blockChars = toUtterances(reply.text, { firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS }).map((b) => [...b].length);
    const firstBlockChars = blockChars[0];
    if (firstBlockChars === undefined) throw new Error(`${reply.id}: the splitter returned no blocks`);
    return { id: reply.id, shape: reply.shape, firstBlockChars, blocks: blockChars.length, blockChars };
  });
  const overCap = replies.filter((row) => row.firstBlockChars > VOICE_FIRST_BLOCK_MAX_CHARS);
  if (overCap.length) {
    throw new Error(`replies over the ${VOICE_FIRST_BLOCK_MAX_CHARS}-char cap: ${overCap.map((row) => `${row.id} (${row.firstBlockChars})`).join(", ")}`);
  }

  const listing = {
    kind: "voice-latency-firstblock-listing",
    label: LABEL,
    corpusFixtureId: corpusSha,
    splitter: {
      entry: "server/tts/speech-text.ts#toUtterances",
      option: "firstBlockMaxChars, set by /api/tts/prepare",
      minChars: 12,
      maxChars: 320,
      firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS,
    },
    replies,
    totals: {
      replies: replies.length,
      worstFirstBlockChars: Math.max(...replies.map((row) => row.firstBlockChars)),
      cap: VOICE_FIRST_BLOCK_MAX_CHARS,
      repliesOverCap: overCap.length,
    },
    measuredBuildCommit: process.env.OMB_MEASURED_COMMIT ?? "(unset: worktree HEAD)",
    date: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model ?? null },
    offline: true,
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  const path = join(LOGS_DIR, `${LABEL}-${corpusSha.slice(0, 12)}.json`);
  writeFileSync(path, `${JSON.stringify(listing, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, path, corpusFixtureId: corpusSha, ...listing.totals }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
