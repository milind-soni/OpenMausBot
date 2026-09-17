// Piper's pure surfaces: the argv we hand the engine, and the voice list the
// settings panel shows. Both are pinned here rather than by a real spawn —
// the engine is a per-machine install, so a test that needed it would only
// ever run on the machine that already has one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  PIPER_TUNING,
  listPiperVoices,
  piperAvailable,
  piperSynthesisArgs,
  piperVoiceQuality,
} from "./piper.ts";

const roots: string[] = [];

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `astra-piper-${label}-`));
  roots.push(dir);
  return dir;
}

/** A voices/ dir whose .onnx files declare the given qualities. */
function voicesDir(voices: Array<[string, string | null]>): string {
  const dir = join(tempRoot("voices"), "voices");
  mkdirSync(dir, { recursive: true });
  for (const [id, quality] of voices) {
    writeFileSync(join(dir, `${id}.onnx`), "");
    if (quality !== null) {
      writeFileSync(
        join(dir, `${id}.onnx.json`),
        JSON.stringify({ audio: { quality }, num_speakers: 1 }),
      );
    }
  }
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("piperSynthesisArgs", () => {
  it("passes the model, the output file and every tuning value", () => {
    const args = piperSynthesisArgs("/voices/en_US-ryan-high.onnx", "/tmp/out.wav");
    expect(args[args.indexOf("--model") + 1]).toBe("/voices/en_US-ryan-high.onnx");
    expect(args[args.indexOf("--output_file") + 1]).toBe("/tmp/out.wav");
    expect(args[args.indexOf("--length_scale") + 1]).toBe(String(PIPER_TUNING.lengthScale));
    expect(args[args.indexOf("--noise_scale") + 1]).toBe(String(PIPER_TUNING.noiseScale));
    expect(args[args.indexOf("--noise_w") + 1]).toBe(String(PIPER_TUNING.noiseW));
    expect(args[args.indexOf("--sentence_silence") + 1]).toBe(String(PIPER_TUNING.sentenceSilence));
  });

  it("leaves the noise floor at upstream defaults", () => {
    // Deliberate: these are the values piper tuned its published voices
    // against, so drifting from them buys instability rather than realism.
    expect(PIPER_TUNING.noiseScale).toBe(0.667);
    expect(PIPER_TUNING.noiseW).toBe(0.8);
  });

  it("keeps the per-clip silence tail short", () => {
    // The harness synthesizes ONE clip PER SENTENCE and plays them
    // back-to-back, so a 0.2s baked-in tail (piper's default, which assumes
    // one clip per answer) would repeat at every sentence boundary and read
    // as choppiness. Regression guard: this must stay well under upstream's.
    expect(PIPER_TUNING.sentenceSilence).toBeLessThan(0.2);
  });

  it("keeps the speaking rate at a conversational pace, not a sprint", () => {
    // Measured on en_US-ryan-high over one fixed sentence: 0.95 spoke at
    // 238 wpm and 1.0 at 226 — both well past conversational English, which
    // is what "sounds like a machine" mostly is. The guard is a band, not a
    // constant: anything at or below 1.0 is back to the hurried read.
    expect(PIPER_TUNING.lengthScale).toBeGreaterThan(1);
    expect(PIPER_TUNING.lengthScale).toBeLessThan(1.4);
  });

  it("omits --speaker unless one is chosen", () => {
    expect(piperSynthesisArgs("m.onnx", "o.wav")).not.toContain("--speaker");
    const withSpeaker = piperSynthesisArgs("m.onnx", "o.wav", { ...PIPER_TUNING, speaker: 3 });
    expect(withSpeaker[withSpeaker.indexOf("--speaker") + 1]).toBe("3");
  });

  it("honors a caller's tuning instead of the shared defaults", () => {
    const args = piperSynthesisArgs("m.onnx", "o.wav", {
      lengthScale: 1.25,
      noiseScale: 0.5,
      noiseW: 0.5,
      sentenceSilence: 0.3,
    });
    expect(args[args.indexOf("--length_scale") + 1]).toBe("1.25");
    expect(args[args.indexOf("--sentence_silence") + 1]).toBe("0.3");
  });
});

describe("listPiperVoices", () => {
  it("orders best quality first, then by name", () => {
    const dir = voicesDir([
      ["en_US-amy-medium", "medium"],
      ["en_US-ryan-high", "high"],
      ["en_US-lessac-low", "low"],
      ["en_GB-alba-x_low", "x_low"],
    ]);
    expect(listPiperVoices(dir).map((v) => v.id)).toEqual([
      "en_US-ryan-high",
      "en_US-amy-medium",
      "en_US-lessac-low",
      "en_GB-alba-x_low",
    ]);
  });

  it("breaks ties between equal qualities by id", () => {
    const dir = voicesDir([
      ["en_US-zelda-high", "high"],
      ["en_US-anna-high", "high"],
    ]);
    expect(listPiperVoices(dir).map((v) => v.id)).toEqual(["en_US-anna-high", "en_US-zelda-high"]);
  });

  it("keeps voices whose metadata is missing, ranked last", () => {
    const dir = voicesDir([
      ["en_US-amy-medium", "medium"],
      ["handmade", null],
    ]);
    const voices = listPiperVoices(dir);
    expect(voices.map((v) => v.id)).toEqual(["en_US-amy-medium", "handmade"]);
    expect(voices[1].description).toBe("offline neural voice");
  });

  it("labels a voice with just the speaker's name", () => {
    const dir = voicesDir([
      ["en_US-ryan-high", "high"],
      ["en_GB-alba-x_low", "x_low"],
    ]);
    const byId = new Map(listPiperVoices(dir).map((v) => [v.id, v]));
    // the locale and the tier both live in the description, not the label
    expect(byId.get("en_US-ryan-high")?.label).toBe("Ryan");
    expect(byId.get("en_GB-alba-x_low")?.label).toBe("Alba");
    expect(byId.get("en_US-ryan-high")?.description).toBe("offline neural voice — high quality");
  });

  it("ignores everything that is not an .onnx voice", () => {
    const dir = voicesDir([["en_US-amy-medium", "medium"]]);
    writeFileSync(join(dir, "notes.txt"), "not a voice");
    writeFileSync(join(dir, "orphan.onnx.json"), "{}");
    expect(listPiperVoices(dir).map((v) => v.id)).toEqual(["en_US-amy-medium"]);
  });

  it("returns nothing for a dir that does not exist", () => {
    expect(listPiperVoices(join(tempRoot("absent"), "voices"))).toEqual([]);
  });

  it("reads the declared quality, or null when it declares none", () => {
    const dir = voicesDir([
      ["en_US-ryan-high", "high"],
      ["handmade", null],
    ]);
    expect(piperVoiceQuality(dir, "en_US-ryan-high")).toBe("high");
    expect(piperVoiceQuality(dir, "handmade")).toBeNull();
  });
});

describe("piperAvailable", () => {
  it("is true when the engine binary sits in the root", () => {
    const root = tempRoot("engine");
    expect(piperAvailable(root)).toBe(false);
    writeFileSync(join(root, process.platform === "win32" ? "piper.exe" : "piper"), "");
    expect(piperAvailable(root)).toBe(true);
  });

  it("is false for a root that does not exist", () => {
    expect(piperAvailable(join(tempRoot("absent-root"), "piper"))).toBe(false);
  });
});