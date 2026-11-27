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

/** The header above `say -v ?`'s table is localized, so anything without the `name  lang  # sample` shape is ignored. */
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

/** 22 kHz mono WAV, written by `say` itself; an empty voice id is the system's own default. */
export async function synthesizeSystem(text: string, voiceId: string | undefined, run: Runner = defaultRun): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const dir = await mkdtemp(join(tmpdir(), "openmausbot-say-"));
  const out = join(dir, "utterance.wav");
  try {
    const args = ["-o", out, "--data-format=LEI16@22050"];
    if (voiceId?.trim()) args.push("-v", voiceId.trim());
    // `say` reads a leading "--input-file=" or "--output-file=" in the text as its own option; after `--` it is speech.
    args.push("--", trimmed);
    await run(SAY, args, 30_000);
    return { bytes: new Uint8Array(await readFile(out)), mime: "audio/wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
