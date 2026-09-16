// Piper (https://github.com/rhasspy/piper) — neural, fully OFFLINE speech.
// The realistic-sounding zero-key engine: an ONNX voice model per speaker,
// synthesized on this machine with no network and no account. It sits beside
// the built-in SAPI/`say` engines, which work everywhere but sound robotic —
// Piper is the offline engine you pick when the voice should sound human.
//
// The engine and voice models live in ~/.openmausbot/piper (engine binary at
// the root, voices/ beside it). Nothing here downloads or updates anything at
// runtime; provisioning is a documented manual step and the provider simply
// never appears as an option when the engine is absent.
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Audio, Voice } from "./elevenlabs.ts";

const execFileAsync = promisify(execFile);

const PIPER_ROOT = join(homedir(), ".openmausbot", "piper");
const VOICES_DIR = join(PIPER_ROOT, "voices");
const ENGINE_TIMEOUT_MS = 60_000;

export function piperRoot(): string {
  return PIPER_ROOT;
}

export function piperAvailable(): boolean {
  return existsSync(join(PIPER_ROOT, "piper.exe")) || existsSync(join(PIPER_ROOT, "piper"));
}

/** Every *.onnx in voices/ is a speakable voice; the sibling .onnx.json
 * carries its metadata (sample rate, speaker name). */
export function listPiperVoices(): Voice[] {
  if (!piperAvailable() || !existsSync(VOICES_DIR)) return [];
  const voices: Voice[] = [];
  try {
    for (const file of readdirSync(VOICES_DIR)) {
      if (!file.endsWith(".onnx")) continue;
      const id = file.replace(/\.onnx$/, "");
      const label = id
        .replace(/^en_US-/, "")
        .replace(/^en_GB-/, "")
        .replace(/-(medium|high|low|x_low)$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      let description = "offline neural voice";
      try {
        const meta = JSON.parse(
          readFileSync(join(VOICES_DIR, `${id}.onnx.json`), "utf8"),
        ) as { audio?: { quality?: string } };
        const quality = meta.audio?.quality;
        if (quality) description = `offline neural voice — ${quality} quality`;
      } catch {}
      voices.push({ id, label, description });
    }
  } catch {
    return [];
  }
  return voices.sort((a, b) => a.id.localeCompare(b.id));
}

function resolveVoiceFile(voiceId: string | undefined): string | null {
  if (!existsSync(VOICES_DIR)) return null;
  if (voiceId?.trim()) {
    const candidate = join(VOICES_DIR, `${voiceId.trim()}.onnx`);
    if (existsSync(candidate)) return candidate;
  }
  // No voice picked (or it was removed): fall back to a deterministic first.
  const voices = listPiperVoices();
  if (!voices.length) return null;
  return join(VOICES_DIR, `${voices[0].id}.onnx`);
}

/** Synthesize one utterance to 22 kHz mono WAV. Text goes in over stdin
 * (UTF-8, no command-line quoting pitfalls); piper writes the file itself. */
export async function synthesizePiper(text: string, voiceId?: string): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const engine = join(PIPER_ROOT, process.platform === "win32" ? "piper.exe" : "piper");
  if (!existsSync(engine)) throw new Error("Piper engine is not installed.");
  const model = resolveVoiceFile(voiceId);
  if (!model) throw new Error("No Piper voice models are installed.");
  const dir = await mkdtemp(join(piperRoot(), "synth-"));
  const out = join(dir, "utterance.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine, ["--model", model, "--output_file", out], {
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

// Re-exported so tests can drive the list path through the same
// execFileAsync-shaped contract the other engines use.
export const _execFileAsync = execFileAsync;
