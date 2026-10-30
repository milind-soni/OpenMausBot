#!/usr/bin/env node
// First-byte proof row for the voice-latency record protocol: measures the
// synthesis leg alone — the real synthesize() in server/tts/elevenlabs.ts
// against the committed stub — and writes the 319-char unpunctuated reply's
// first-byte timing. Modeled numbers only: no live engine call, no engine key.
import { execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toUtterances } from "../../server/tts/speech-text.ts";
import { synthesize } from "../../server/tts/elevenlabs.ts";
import {
  corpusFixtureId,
  CORPUS_PATH,
  MANIFEST_PATH,
  readLfText,
  SYNTHESIS,
} from "./voice-latency-corpus.ts";
import { launchVoiceLatencyStub, STUB_KEY, STUB_MODEL, STUB_VOICE } from "./voice-latency-stub.ts";

const REPLY_ID = "unpunctuated-run-319";
const BLOCK_CHARS = 319;
const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(HERE, "fixtures", "voice-latency", "logs");
const LABEL = "firstbyte";
const BASE_COMMIT = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: join(HERE, "..", "..") }).toString().trim();

interface CorpusReply {
  id: string;
  shape: string;
  text: string;
}

async function main(): Promise<void> {
  const corpusText = readLfText(CORPUS_PATH);
  const corpusSha = corpusFixtureId(corpusText);
  const manifest = JSON.parse(readLfText(MANIFEST_PATH)) as { corpusFixtureId: string };
  if (manifest.corpusFixtureId !== corpusSha) {
    throw new Error(`corpus fixture drift: manifest ${manifest.corpusFixtureId} != file ${corpusSha}`);
  }
  const corpus = JSON.parse(corpusText) as { replies: CorpusReply[] };
  const reply = corpus.replies.find((row) => row.id === REPLY_ID);
  if (!reply) throw new Error(`corpus has no reply ${REPLY_ID}`);

  // The app synthesizes per utterance block, so the row speaks block 0 — the
  // pinned worst first block — exactly as /api/tts/prepare splits it.
  const block = toUtterances(reply.text)[0] ?? "";
  if ([...block].length !== BLOCK_CHARS) {
    throw new Error(`${REPLY_ID}: first block is ${[...block].length} chars, expected ${BLOCK_CHARS}`);
  }

  const stub = await launchVoiceLatencyStub();
  try {
    const began = Date.now();
    const clip = synthesize(block, STUB_VOICE, STUB_KEY, stub.url);
    const first = await clip.firstAudio;
    const firstByteMs = Date.now() - began;
    const audio = await clip.audio;
    const completeMs = Date.now() - began;
    if (first.bytes.byteLength === 0 || audio.bytes.byteLength === 0) throw new Error("stub returned empty audio");
    // The streaming property: first audio settles strictly before the whole clip.
    const streamed = firstByteMs < completeMs && firstByteMs < 1_000;
    if (!streamed) {
      throw new Error(`not streamed: first byte ${firstByteMs} ms vs complete ${completeMs} ms`);
    }

    const row = {
      kind: "voice-latency-firstbyte-row",
      label: LABEL,
      corpusFixtureId: corpusSha,
      replyId: reply.id,
      shape: reply.shape,
      blockChars: BLOCK_CHARS,
      request: { route: "text-to-speech", streamed },
      firstByteMs,
      completeMs,
      firstByteBeforeCompletion: streamed,
      baseCommit: BASE_COMMIT,
      measuredBuildCommit: process.env.OMB_MEASURED_COMMIT ?? "(unset: worktree HEAD)",
      date: new Date().toISOString(),
      machine: { platform: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model ?? null },
      configSummary: { provider: "elevenlabs (record stub)", model: STUB_MODEL, voice: STUB_VOICE },
      synthesis: {
        protocol: "elevenlabs-wire stub on loopback; no live engine call, no engine key",
        modeled: true,
        rtf: SYNTHESIS.rtf,
        audioMsPerChar: SYNTHESIS.audioMsPerChar,
        firstByteMs: SYNTHESIS.firstByteMs,
      },
      modeled: true,
    };
    mkdirSync(LOGS_DIR, { recursive: true });
    const path = join(LOGS_DIR, `${LABEL}-${corpusSha.slice(0, 12)}.json`);
    writeFileSync(path, `${JSON.stringify(row, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, path, corpusFixtureId: corpusSha, firstByteMs, completeMs }, null, 2)}\n`);
  } finally {
    await stub.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
