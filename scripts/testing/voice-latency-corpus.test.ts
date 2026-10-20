import { describe, expect, it } from "vitest";
import { toUtterances } from "../../server/tts/speech-text.ts";
import {
  buildCorpus,
  CADENCE,
  CORPUS_PATH,
  corpusFixtureId,
  corpusJson,
  type CorpusTotals,
  GAP_THRESHOLD_MS,
  MANIFEST_PATH,
  measureCorpus,
  type ReplyMeasurement,
  readLfText,
  SYNTHESIS,
} from "./voice-latency-corpus.ts";

const canonical = corpusJson(buildCorpus());
const committed = readLfText(CORPUS_PATH);
const committedSha = corpusFixtureId(committed);

// The committed fixture is the corpus of record for any before/after
// measurement of the speak pipeline: both sides speak these exact bytes.
describe("voice latency corpus fixture", () => {
  it("regenerates the committed corpus byte-for-byte", () => {
    expect(canonical).toBe(committed);
  });

  it("the manifest's fixture id is the sha256 of the committed corpus", () => {
    const manifest = JSON.parse(readLfText(MANIFEST_PATH)) as { corpusFixtureId: string };
    expect(manifest.corpusFixtureId).toBe(committedSha);
  });

  it("manifest numbers come from the real toUtterances on the committed replies", () => {
    const manifest = JSON.parse(readLfText(MANIFEST_PATH)) as {
      totals: CorpusTotals;
      replies: ReplyMeasurement[];
    };
    const measured = measureCorpus(buildCorpus());
    expect(manifest.totals).toEqual(measured.totals);
    expect(manifest.replies).toEqual(measured.replies);
    // Every block length is re-derived from the splitter, not trusted.
    for (const reply of measured.replies) {
      expect(reply.blockChars).toEqual(toUtterances(buildCorpus().find((r) => r.id === reply.id)!.text).map((b) => [...b].length));
    }
  });

  it("lands on the pinned totals: 116 blocks, mean about 66 chars", () => {
    const { totals } = measureCorpus(buildCorpus());
    expect(totals.blocks).toBe(116);
    expect(totals.meanBlockChars).toBeGreaterThan(64);
    expect(totals.meanBlockChars).toBeLessThan(68);
  });

  it("carries the pinned worst first blocks", () => {
    const { replies } = measureCorpus(buildCorpus());
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    expect(byId.get("unpunctuated-run-319")!.firstBlockChars).toBe(319);
    expect(byId.get("code-list-211")!.firstBlockChars).toBe(211);
    expect(byId.get("em-dash-list-153")!.firstBlockChars).toBe(153);
    expect(byId.get("typical-medium-26")!.firstBlockChars).toBe(26);
    expect(byId.get("staccato-92")!.blocks).toBe(1);
    expect(byId.get("staccato-92")!.blockChars[0]).toBe(92);
    expect(byId.get("mixed-late-319")!.blockChars.at(-1)).toBe(319);
  });

  it("documents the replay cadence both sides share", () => {
    expect(CADENCE.chunkChars).toBeGreaterThan(0);
    expect(CADENCE.intervalMs).toBeGreaterThan(0);
  });

  it("pins the gap threshold the protocol shares", () => {
    const manifest = JSON.parse(readLfText(MANIFEST_PATH)) as { gapThresholdMs: number };
    expect(manifest.gapThresholdMs).toBe(GAP_THRESHOLD_MS);
  });

  it("pins the modeled synthesis timing both sides share", () => {
    const manifest = JSON.parse(readLfText(MANIFEST_PATH)) as { synthesis: typeof SYNTHESIS };
    expect(manifest.synthesis).toEqual(SYNTHESIS);
  });
});
