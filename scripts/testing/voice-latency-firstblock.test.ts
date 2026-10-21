import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toUtterances, VOICE_FIRST_BLOCK_MAX_CHARS } from "../../server/tts/speech-text.ts";
import { corpusFixtureId, CORPUS_PATH, readLfText } from "./voice-latency-corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const committed = readLfText(CORPUS_PATH);
const committedSha = corpusFixtureId(committed);
const LISTING_PATH = join(HERE, "fixtures", "voice-latency", "logs", `firstblock-${committedSha.slice(0, 12)}.json`);

interface CorpusReply {
  id: string;
  text: string;
}

interface ListingRow {
  id: string;
  firstBlockChars: number;
  blockChars: number[];
}

describe("voice latency first-block listing", () => {
  it("no committed corpus reply has a first block over the voice cap", () => {
    const corpus = JSON.parse(committed) as { replies: CorpusReply[] };
    for (const reply of corpus.replies) {
      const first = toUtterances(reply.text, { firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS })[0];
      expect([...(first ?? "")].length, reply.id).toBeLessThanOrEqual(VOICE_FIRST_BLOCK_MAX_CHARS);
    }
  });

  it("the committed listing comes from the real capped splitter on the committed replies", () => {
    const listing = JSON.parse(readLfText(LISTING_PATH)) as {
      corpusFixtureId: string;
      splitter: { firstBlockMaxChars: number };
      replies: ListingRow[];
    };
    expect(listing.corpusFixtureId).toBe(committedSha);
    expect(listing.splitter.firstBlockMaxChars).toBe(VOICE_FIRST_BLOCK_MAX_CHARS);
    const corpus = JSON.parse(committed) as { replies: CorpusReply[] };
    for (const row of listing.replies) {
      const blockChars = toUtterances(corpus.replies.find((reply) => reply.id === row.id)!.text, {
        firstBlockMaxChars: VOICE_FIRST_BLOCK_MAX_CHARS,
      }).map((block) => [...block].length);
      expect(row.blockChars, row.id).toEqual(blockChars);
      expect(row.firstBlockChars, row.id).toBe(blockChars[0]);
    }
  });
});
