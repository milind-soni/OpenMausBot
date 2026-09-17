// Config-only voice regression; never starts microphones or contacts speech providers.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-astra.ts";

const fixture = await launchVerificationServer();
try {
  const configPath = join(fixture.info.dataDir, "config.json");
  const disk = JSON.parse(readFileSync(configPath, "utf8"));
  disk.dictation = { key: "fixture-retired-stored-key" };
  writeFileSync(configPath, JSON.stringify(disk));
  const request = async (patch?: unknown) => {
    const response = await fetch(`${fixture.info.url}/api/config`, patch === undefined ? {} : {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const status = await response.json();
    assert.equal(response.status, 200, `config request failed: ${JSON.stringify(status)}`);
    assert.equal(Object.hasOwn(status, "dictation"), false);
    for (const secret of ["fixture-retired-stored-key", "fixture-retired-new-key", "fixture-wake-key"]) {
      assert.equal(JSON.stringify(status).includes(secret), false);
    }
    return status;
  };
  await request();
  // A patch holding ONLY the retired section parses to nothing: 400, no save,
  // and the legacy plaintext value is left untouched on disk.
  const retiredOnly = await fetch(`${fixture.info.url}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dictation: { key: "fixture-retired-new-key" } }),
  });
  assert.equal(retiredOnly.status, 400);
  assert.deepEqual(JSON.parse(await retiredOnly.text()), { error: "nothing to save" });
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).dictation, disk.dictation);
  const saved = await request({
    dictation: { key: "fixture-retired-new-key" },
    wakeWord: { accessKey: "fixture-wake-key" },
    tts: { provider: "system" },
  });
  assert.equal(saved.wakeWord.configured, true);
  assert.equal(saved.tts.configured, true);
  assert.equal(saved.tts.provider, "system");
  const reloaded = await request();
  assert.equal(reloaded.wakeWord.configured, true);
  assert.equal(reloaded.tts.provider, "system");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).dictation, disk.dictation);
  const cleared = await request({ wakeWord: { accessKey: "" }, tts: { provider: "elevenlabs" } });
  assert.equal(cleared.wakeWord.configured, false);
  assert.equal(cleared.tts.configured, false);
  console.log(JSON.stringify({ ok: true, ...fixture.info, findings: [
    "GET/PUT config omit retired dictation status and never echo fixture secrets",
    "a dictation-only patch is rejected (400 nothing to save) and never written",
    "legacy stored dictation is inert and preserved; incoming replacement is ignored",
    "wake-word credential saves, reloads and clears; keyless TTS settings persist",
  ] }, null, 2));
} finally {
  await fixture.close();
}
