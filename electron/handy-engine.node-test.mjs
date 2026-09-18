// Handy's engine resolution and readout, pinned without Electron, without a
// microphone, and without touching the user's real Handy install.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HANDY_BARE_EXE,
  handyExeMissing,
  isHandyModelFile,
  readHandyCatalog,
  readHandyEngine,
  resolveHandyExe,
} from "./handy-engine.mjs";

const environment = (exists, platform = "win32") => ({ home: "C:\\Users\\fixture", platform, exists });

test("an explicit path from Settings always wins", () => {
  assert.equal(
    resolveHandyExe("D:\\tools\\handy.exe", environment(() => true)),
    "D:\\tools\\handy.exe",
  );
});

test("a blank setting falls back to the per-user install, then the bare name", () => {
  const fallback = join("C:\\Users\\fixture", "AppData", "Local", "Handy", "handy.exe");
  assert.equal(resolveHandyExe("", environment((candidate) => candidate === fallback)), fallback);
  assert.equal(resolveHandyExe("", environment(() => false)), HANDY_BARE_EXE);
  // Whitespace is the same as empty: the setting is a free-text field.
  assert.equal(resolveHandyExe("   ", environment(() => false)), HANDY_BARE_EXE);
});

test("macOS prefers the app bundle it actually ships", () => {
  const exists = (candidate) => candidate === "/Applications/Handy.app/Contents/MacOS/handy";
  assert.equal(
    resolveHandyExe("", environment(exists, "darwin")),
    "/Applications/Handy.app/Contents/MacOS/handy",
  );
});

test("a missing install is reported as missing, a resolved one is not", () => {
  assert.equal(handyExeMissing(HANDY_BARE_EXE, () => false), true);
  assert.equal(handyExeMissing("D:\\tools\\handy.exe", () => false), false);
  assert.equal(handyExeMissing(HANDY_BARE_EXE, () => true), false);
});

test("AppleDouble companions do not count as models", () => {
  assert.equal(isHandyModelFile("encoder-model.int8.onnx"), true);
  assert.equal(isHandyModelFile("canary-180m-flash-Q8_0.gguf"), true);
  assert.equal(isHandyModelFile("model.bin"), true);
  assert.equal(isHandyModelFile("._encoder-model.int8.onnx"), false);
  assert.equal(isHandyModelFile("vocab.txt"), false);
});

test("the readout reports Handy's selection alongside what is actually on disk", async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), "astra-handy-engine-"));
  try {
    const dir = join(appDataDir, "com.pais.handy");
    const models = join(dir, "models");
    mkdirSync(join(models, "parakeet-tdt-0.6b-v2-int8"), { recursive: true });
    writeFileSync(join(models, "parakeet-tdt-0.6b-v2-int8", "encoder-model.int8.onnx"), "");
    // A folder with no model file in it is not a model.
    mkdirSync(join(models, "not-a-model"), { recursive: true });
    writeFileSync(join(models, "not-a-model", "vocab.txt"), "");
    const selected = "handy-computer/canary-180m-flash-gguf/canary-180m-flash-Q8_0.gguf";
    writeFileSync(join(dir, "settings_store.json"), JSON.stringify({ settings: { selected_model: selected } }));

    const status = await readHandyEngine({
      handyPath: "",
      appDataDir,
      environment: environment((candidate) => candidate.endsWith("handy.exe")),
    });
    assert.equal(status.ok, true);
    assert.equal(status.found, true);
    assert.equal(status.selected, selected);
    assert.deepEqual(status.installed, ["parakeet-tdt-0.6b-v2-int8"]);
    assert.ok(status.device.cores >= 1);
    assert.ok(status.device.ramGB > 0);
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});

test("the catalog supplies the only ids a pin can legally use", async () => {
  const run = async () =>
    JSON.stringify([
      { id: "parakeet-tdt-0.6b-v2", name: "Parakeet V2", size_mb: 451, is_downloaded: true, source: { HuggingFace: {} } },
      { id: "parakeet-tdt-0.6b-v3", size_mb: 456, is_downloaded: false },
      { id: "", name: "broken entry" },
    ]);
  assert.deepEqual(await readHandyCatalog({ exe: "handy", run }), [
    { id: "parakeet-tdt-0.6b-v2", name: "Parakeet V2", sizeMB: 451, downloaded: true },
    // No name in the payload: the id is the only honest label, not a blank.
    { id: "parakeet-tdt-0.6b-v3", name: "parakeet-tdt-0.6b-v3", sizeMB: 456, downloaded: false },
  ]);
});

test("a catalog Handy cannot answer leaves the picker empty instead of throwing", async () => {
  const runnables = [
    async () => {
      throw new Error("spawn failed");
    },
    async () => "handy: not json",
    async () => JSON.stringify({ models: [] }),
  ];
  for (const run of runnables) {
    assert.deepEqual(await readHandyCatalog({ exe: "handy", run }), []);
  }
});

test("the catalog call is bounded and asks for JSON", async () => {
  let seen;
  const catalog = await readHandyCatalog({
    exe: "handy.exe",
    timeoutMs: 1_234,
    run: async (exe, args, timeoutMs) => {
      seen = { exe, args, timeoutMs };
      return "[]";
    },
  });
  assert.deepEqual(seen, { exe: "handy.exe", args: ["--list-models", "--json"], timeoutMs: 1_234 });
  assert.deepEqual(catalog, []);
});

test("an install with nothing readable reports that honestly instead of throwing", async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), "astra-handy-engine-absent-"));
  try {
    const status = await readHandyEngine({ handyPath: "", appDataDir, environment: environment(() => false) });
    assert.equal(status.ok, true);
    assert.equal(status.found, false);
    assert.equal(status.selected, null);
    assert.deepEqual(status.installed, []);
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});
