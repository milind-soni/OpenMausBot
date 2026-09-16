// Piper (https://github.com/rhasspy/piper) — neural, fully OFFLINE speech.
// The realistic-sounding zero-key engine: an ONNX voice model per speaker,
// synthesized on this machine with no network and no account. It sits beside
// the built-in SAPI/`say` engines, which work everywhere but sound robotic —
// Piper is the offline engine you pick when the voice should sound human.
//
// The engine and voice models live in ~/.astra/piper (engine binary at
// the root, voices/ beside it). Nothing here downloads or updates anything at
// runtime; provisioning is a documented manual step and the provider simply
// never appears as an option when the engine is absent.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import type { Audio, Voice } from "./elevenlabs.ts";

// Derived from DATA_DIR like every other server-owned path, so an
// ASTRA_DATA_DIR override (test rigs, the soak harness) relocates the engine
// with the rest of the workspace instead of silently reading the real home.
const PIPER_ROOT = join(DATA_DIR, "piper");
const VOICES_DIR = join(PIPER_ROOT, "voices");
const ENGINE_TIMEOUT_MS = 60_000;

export function piperRoot(): string {
  return PIPER_ROOT;
}

export function piperAvailable(root: string = PIPER_ROOT): boolean {
  return existsSync(join(root, "piper.exe")) || existsSync(join(root, "piper"));
}

/** Model quality tiers, worst → best, as named by the voice files themselves
 * (`en_US-ryan-high`, `en_US-amy-medium`, …). Used only for ordering. */
const QUALITY_RANK: Record<string, number> = { x_low: 0, low: 1, medium: 2, high: 3 };

/** `en_US-ryan-high` → `ryan high`; the locale and tier are already visible
 * in the description, so the label stays just the speaker's name. */
function voiceLabel(id: string): string {
  return id
    .replace(/^[a-z]{2}_[A-Z]{2}-/, "")
    .replace(/-(x_low|low|medium|high)$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The tier a voice file declares, or null when it declares nothing
 * (hand-built models, older releases). */
export function piperVoiceQuality(voicesDir: string, id: string): string | null {
  try {
    const meta = JSON.parse(
      readFileSync(join(voicesDir, `${id}.onnx.json`), "utf8"),
    ) as { audio?: { quality?: string } };
    return meta.audio?.quality ?? null;
  } catch {
    return null;
  }
}

/**
 * Every *.onnx in voices/ is a speakable voice; the sibling .onnx.json
 * carries its metadata.
 *
 * Ordered best-quality-first, then by name. The order is user-visible — it is
 * what Settings lists and what an unset voice falls back to — and quality is
 * the property that decides how the voice actually sounds, so it outranks the
 * alphabet. A machine with amy-medium and ryan-high installed should offer
 * ryan first, not whoever sorts earlier.
 */
export function listPiperVoices(voicesDir: string = VOICES_DIR): Voice[] {
  if (!existsSync(voicesDir)) return [];
  const voices: Array<Voice & { rank: number }> = [];
  try {
    for (const file of readdirSync(voicesDir)) {
      if (!file.endsWith(".onnx")) continue;
      const id = file.replace(/\.onnx$/, "");
      const quality = piperVoiceQuality(voicesDir, id);
      voices.push({
        id,
        label: voiceLabel(id),
        description: quality
          ? `offline neural voice — ${quality} quality`
          : "offline neural voice",
        rank: quality ? (QUALITY_RANK[quality] ?? -1) : -1,
      });
    }
  } catch {
    return [];
  }
  return voices
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
    .map(({ id, label, description }) => ({ id, label, description }));
}

/**
 * Synthesis knobs, passed explicitly because each one changes product
 * behavior rather than just the wire (same rule as the Deepgram query):
 *
 *   lengthScale      speaking rate; <1 is faster. Piper's 1.0 is a measured,
 *                    lecture pace — 0.95 reads as conversation without
 *                    sounding hurried.
 *   noiseScale       generator noise (expressiveness/variation).
 *   noiseW           phoneme-width noise (cadence variation). Both noise
 *                    values stay at piper's own defaults: upstream tuned them
 *                    against the published voices, and drifting from them
 *                    buys instability, not realism.
 *   sentenceSilence  trailing silence baked into every clip. Upstream's 0.2s
 *                    assumes ONE clip per answer; this harness synthesizes
 *                    one clip PER SENTENCE and plays them back-to-back, so
 *                    0.2s would repeat at every sentence boundary and read as
 *                    choppiness. A small tail leaves the pacing to the client.
 */
export interface PiperTuning {
  lengthScale: number;
  noiseScale: number;
  noiseW: number;
  sentenceSilence: number;
  /** Multi-speaker models only (`num_speakers` > 1 in the .onnx.json). */
  speaker?: number;
}

export const PIPER_TUNING: PiperTuning = {
  lengthScale: 0.95,
  noiseScale: 0.667,
  noiseW: 0.8,
  sentenceSilence: 0.05,
};

/** The engine's argv for one utterance. Pure so the flags are pinned by
 * tests instead of by a real spawn. */
export function piperSynthesisArgs(
  model: string,
  outputFile: string,
  tuning: PiperTuning = PIPER_TUNING,
): string[] {
  const args = [
    "--model", model,
    "--output_file", outputFile,
    "--length_scale", String(tuning.lengthScale),
    "--noise_scale", String(tuning.noiseScale),
    "--noise_w", String(tuning.noiseW),
    "--sentence_silence", String(tuning.sentenceSilence),
  ];
  if (tuning.speaker !== undefined) args.push("--speaker", String(tuning.speaker));
  return args;
}

function resolveVoiceFile(voiceId: string | undefined, voicesDir: string): string | null {
  if (!existsSync(voicesDir)) return null;
  if (voiceId?.trim()) {
    const candidate = join(voicesDir, `${voiceId.trim()}.onnx`);
    if (existsSync(candidate)) return candidate;
  }
  // No voice picked (or it was removed): the best-quality voice, which is
  // what listPiperVoices orders first.
  const voices = listPiperVoices(voicesDir);
  if (!voices.length) return null;
  return join(voicesDir, `${voices[0].id}.onnx`);
}

/** Synthesize one utterance to 22 kHz mono WAV. Text goes in over stdin
 * (UTF-8, no command-line quoting pitfalls); piper writes the file itself. */
export async function synthesizePiper(
  text: string,
  voiceId?: string,
  tuning: PiperTuning = PIPER_TUNING,
): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const engine = join(PIPER_ROOT, process.platform === "win32" ? "piper.exe" : "piper");
  if (!existsSync(engine)) throw new Error("Piper engine is not installed.");
  const model = resolveVoiceFile(voiceId, VOICES_DIR);
  if (!model) throw new Error("No Piper voice models are installed.");
  const dir = await mkdtemp(join(piperRoot(), "synth-"));
  const out = join(dir, "utterance.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine, piperSynthesisArgs(model, out, tuning), {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Piper synthesis timed out."));
      }, ENGINE_TIMEOUT_MS);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Piper exited ${code}: ${stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`));
      });
      child.stdin?.end(trimmed, "utf8");
    });
    return { bytes: new Uint8Array(await readFile(out)), mime: "audio/wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
