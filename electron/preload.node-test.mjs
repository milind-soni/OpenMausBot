import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

function loadBridge(remote = false) {
  let bridge;
  const calls = [];
  runInNewContext(source, {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "ogb"); bridge = value; } },
        ipcRenderer: {
          on() {},
          removeListener() {},
          invoke(...args) { calls.push(args); return Promise.resolve(); },
        },
        webUtils: {},
      };
    },
    process: { argv: ["--omb-local-origin=http://localhost:5173"], platform: "win32" },
    location: { origin: remote ? "https://remote.example" : "http://localhost:5173" },
  });
  return { bridge, calls };
}

test("local preload retains Handy, clipboard and native speech without cloud STT", async () => {
  const { bridge, calls } = loadBridge();
  assert.equal(Object.hasOwn(bridge, "dictation"), false);
  assert.equal(Object.hasOwn(bridge, "callStt"), false);
  const wav = new ArrayBuffer(8);
  await bridge.handyToggle("fixture-handy");
  await bridge.handyModels("fixture-handy");
  await bridge.handyTranscribeFile(wav, "fixture-handy", "fixture-model");
  await bridge.readClipboardText();
  await bridge.writeClipboardText("fixture transcript");
  await bridge.speechStart({ endpointMs: 600 });
  await bridge.speechStop();
  await bridge.speechFinish();
  assert.deepEqual(calls.map(([channel]) => channel), [
    "handy:toggle", "handy:models",
    "handy:transcribe-file", "clipboard:read-text", "clipboard:write-text",
    "speech:start", "speech:stop", "speech:finish",
  ]);
  assert.equal(calls[2][1], wav);
  assert.equal(calls[2][2], "fixture-handy");
  assert.equal(calls[2][3], "fixture-model");
});

test("remote preload exposes neither local transcription nor cloud STT", () => {
  const { bridge } = loadBridge(true);
  for (const name of [
    "dictation", "callStt", "handyToggle", "handyModels",
    "handyTranscribeFile", "speechStart", "readClipboardText",
  ]) {
    assert.equal(Object.hasOwn(bridge, name), false, name);
  }
});

test("main and bridge declarations have no retired cloud STT wiring", () => {
  for (const file of ["./main.mjs", "./preload.cjs", "../src/types/ogb.d.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /Deepgram|dictation-stt|callStt|call-stt:|["']dictation:|dictationApiKey|ASTRA_DICTATION_KEY/);
  }
});
