// Built-in macOS speech synthesis — the zero-key voice provider.
//
// Calls and spoken replies work with no ElevenLabs account by using the
// voices already installed on the Mac (`/usr/bin/say`, the same engine the
// Spoken Content pane uses). Everything about driving `say` lives in this
// file: listing voices, and turning one utterance into WAV bytes.
//
// It runs on the HARNESS for the same reason ElevenLabs does — one place to
// spawn processes, one place that owns the utterance split — and the
// renderer keeps playing opaque audio bytes, so it never learns or cares
// which provider produced them.
//
// Platform-gated: `say` is a Darwin binary. Elsewhere the provider simply
// never appears as an option, and the ElevenLabs path is unchanged.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Audio, Voice } from "./elevenlabs.ts";

const SAY = "/usr/bin/say";
const execFileAsync = promisify(execFile);

export function systemVoicesAvailable(platform: string = process.platform): boolean {
  return platform === "darwin";
}

export type Runner = (file: string, args: string[], timeout: number) => Promise<{ stdout: string }>;

const defaultRun: Runner = (file, args, timeout) => execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });

/** Parse `say -v ?` output. Lines look like:
 * `Albert              en_US    # Hello! My name is Albert.`
 * The header above the table is localized, so anything without the
 * `name  lang  # sample` shape is ignored rather than parsed. */
export function parseVoiceList(stdout: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(.+?)\s{2,}(\S+)\s+#\s*(.+)$/.exec(line.trimEnd());
    if (!match) continue;
    const [, name, locale, sample] = match;
    const id = name.trim();
    if (!id) continue;
    voices.push({ id, label: id, description: `${locale} — ${sample.trim()}` });
  }
  return voices;
}

export async function listSystemVoices(run: Runner = defaultRun): Promise<Voice[]> {
  try {
    const { stdout } = await run(SAY, ["-v", "?"], 5_000);
    return parseVoiceList(stdout);
  } catch {
    return [];
  }
}

/** Synthesize one utterance to 22 kHz mono WAV — small, and every browser
 * plays it. `say` writes the container itself; no conversion step needed.
 * The voice id is a system voice name; empty falls back to the system's
 * own default, which is what a fresh Mac already sounds like. */
export async function synthesizeSystem(text: string, voiceId: string | undefined, run: Runner = defaultRun): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const dir = await mkdtemp(join(tmpdir(), "openmausbot-say-"));
  const out = join(dir, "utterance.wav");
  try {
    const args = ["-o", out, "--data-format=LEI16@22050"];
    if (voiceId?.trim()) args.push("-v", voiceId.trim());
    args.push(trimmed);
    await run(SAY, args, 30_000);
    return { bytes: new Uint8Array(await readFile(out)), mime: "audio/wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
