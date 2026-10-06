import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { binaryAsset, speechLocale, whisperLanguage } from "./dictation-languages.mjs";
import { parseWhisperTranscript, whisperStatus } from "./whisper-dictation.mjs";

test("windows x64 gets the cpu whisper.cpp build", () => {
  assert.equal(binaryAsset("win32", "x64")?.file, "whisper-bin-x64.zip");
  assert.equal(binaryAsset("darwin", "arm64"), null);
  assert.equal(whisperLanguage("he"), "he");
  assert.equal(whisperLanguage("../etc"), "auto");
  assert.equal(speechLocale("he-IL"), "he-IL");
  assert.equal(speechLocale("auto"), "");
  assert.equal(speechLocale("--locale"), "");
});

test("transcript parsing drops engine chatter and blank audio", () => {
  assert.equal(
    parseWhisperTranscript("whisper_init_from_file_with_params_no_state\n[BLANK_AUDIO]\nhello there\n"),
    "hello there",
  );
});

test("a tiny file is not an installed model", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "omb-whisper-user-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(userData, "whisper"), { recursive: true });
    await writeFile(path.join(userData, "whisper", "ggml-large-v3-turbo.bin"), "nope");
    const status = await whisperStatus(userData);
    assert.equal(status.installed, false);
    assert.equal(status.model, "Whisper Large v3 Turbo");
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
