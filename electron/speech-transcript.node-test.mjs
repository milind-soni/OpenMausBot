import assert from "node:assert/strict";
import test from "node:test";
import { createSpeechTranscript } from "./speech-transcript.mjs";

const utterance = (text, start, duration = 2) => ({
  partial: true, text, utteranceFinal: true, speechStart: start, speechDuration: duration,
});

test("retains Japanese utterances across pauses and revises only the current partial", () => {
  const transcript = createSpeechTranscript();
  assert.equal(transcript({ text: "今日は", partial: true }).text, "今日は");
  assert.equal(transcript(utterance("今日は大学に行きます。", 0)).text, "今日は大学に行きます。");
  assert.equal(transcript({ text: "その跡", partial: true }).text, "今日は大学に行きます。 その跡");
  assert.equal(transcript({ text: "その後、図書館へ。", partial: true }).text, "今日は大学に行きます。 その後、図書館へ。");
  transcript(utterance("その後、図書館へ。", 5));
  assert.equal(transcript({ text: "最後に帰宅。", partial: false }).text, "今日は大学に行きます。 その後、図書館へ。 最後に帰宅。");
});

test("ignores empty results, including an empty final result", () => {
  const transcript = createSpeechTranscript();
  transcript({ text: "消してはいけない文章", partial: true });
  for (const text of ["", "  ", "\n"]) {
    assert.equal(transcript({ text, partial: true }).text, "消してはいけない文章");
  }
  assert.deepEqual(transcript({ text: "", partial: false }), { text: "消してはいけない文章", partial: false });
});

test("does not append ordinary partial corrections or a shorter correction", () => {
  const transcript = createSpeechTranscript();
  transcript({ text: "会議は明後日です", partial: true });
  assert.equal(transcript({ text: "会議は明日", partial: true }).text, "会議は明日");
});

test("deduplicates repeated utterance-end and final callbacks", () => {
  const transcript = createSpeechTranscript();
  transcript(utterance("最初の文章。", 0));
  transcript(utterance("最初の文章。", 0));
  transcript({ text: "次の文章。", partial: true });
  transcript(utterance("次の文章。", 5));
  assert.equal(transcript({ ...utterance("次の文章。", 5), partial: false }).text, "最初の文章。 次の文章。");
});

test("keeps a deliberately repeated utterance when its audio start differs", () => {
  const transcript = createSpeechTranscript();
  transcript(utterance("はい。", 0));
  transcript({ text: "はい。", partial: true });
  assert.equal(transcript(utterance("はい。", 4)).text, "はい。 はい。");
});

test("also accepts recognizers that keep returning the cumulative transcript", () => {
  const transcript = createSpeechTranscript();
  transcript(utterance("一文目。", 0));
  transcript({ text: "一文目。 二文", partial: true });
  assert.equal(transcript(utterance("一文目。 二文目。", 0, 6)).text, "一文目。 二文目。");
  assert.equal(transcript({ text: "一文目。 二文目。 三文目。", partial: false }).text, "一文目。 二文目。 三文目。");
});

test("preserves an utterance that starts with the same words as its predecessor", () => {
  const transcript = createSpeechTranscript();
  transcript(utterance("はい。", 0));
  transcript({ text: "はい。承知しました。", partial: true });
  assert.equal(transcript(utterance("はい。承知しました。", 5)).text, "はい。 はい。承知しました。");
});

test("allows punctuation corrections in the same finalized audio range", () => {
  const transcript = createSpeechTranscript();
  transcript(utterance("一文目", 0));
  transcript(utterance("一文目。", 0));
  transcript({ text: "二文目", partial: true });
  assert.equal(transcript(utterance("二文目。", 5)).text, "一文目。 二文目。");
});

test("does not discard a disjoint utterance if the recognizer reuses a start timestamp", () => {
  const transcript = createSpeechTranscript();
  transcript(utterance("残すべき文章。", 0));
  assert.equal(transcript(utterance("次の文章。", 0)).text, "残すべき文章。 次の文章。");
});

test("retains a long session with many pauses without emitting session-final events", () => {
  const transcript = createSpeechTranscript();
  const expected = [];
  for (let index = 0; index < 200; index++) {
    const text = `架空の文章${index}。`;
    expected.push(text);
    transcript({ text, partial: true });
    const result = transcript(utterance(text, index * 5));
    assert.equal(result.text, expected.join(" "));
    assert.equal(result.partial, true);
  }
});

test("sessions are independent and errors carry no transcript", () => {
  const first = createSpeechTranscript();
  first(utterance("前のセッション。", 0));
  assert.deepEqual(first({ error: "recognition-error" }), { error: "recognition-error" });
  assert.equal(createSpeechTranscript()({ text: "新しい入力", partial: true }).text, "新しい入力");
});
