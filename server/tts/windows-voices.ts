// Built-in Windows speech synthesis — the zero-key voice provider for
// win32, the counterpart of system-voices.ts (`say` on macOS).
//
// Windows has shipped SAPI voices with the OS since Vista; PowerShell's
// System.Speech assembly drives the same engine without any install, key
// or network. Everything about driving it lives in this file: listing
// voices, and turning one utterance into WAV bytes.
//
// It runs on the HARNESS for the same reason ElevenLabs does — one place
// to spawn processes, one place that owns the utterance split — and the
// renderer keeps playing opaque audio bytes, so it never learns or cares
// which provider produced them.
//
// Platform-gated: the assembly is exercised through Windows PowerShell,
// which only exists on win32. Elsewhere the provider simply never appears
// as an option, and the ElevenLabs path is unchanged.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Audio, Voice } from "./elevenlabs.ts";
import type { Runner } from "./system-voices.ts";

const execFileAsync = promisify(execFile);

/** Windows PowerShell 5.1 ships with the OS. Resolve it by absolute path:
 * hermetic spawn environments (fixtures, packaged shells) carry a PATH
 * that stops at the Node directory, and SystemRoot is the one Windows
 * variable such environments still forward. */
function powershell(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function windowsVoicesAvailable(platform: string = process.platform): boolean {
  return platform === "win32";
}

const defaultRun: Runner = (file, args, timeout) => execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });

/** List the SAPI voices installed on this machine, one
 * `name<TAB>culture<TAB>gender` line per voice via System.Speech. */
export async function listWindowsVoices(run: Runner = defaultRun): Promise<Voice[]> {
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$s.GetInstalledVoices() | ForEach-Object { $i = $_.VoiceInfo; [string]::Join([char]9, @($i.Name, $i.Culture.Name, $i.Gender)) }",
    "$s.Dispose()",
  ].join("; ");
  try {
    const { stdout } = await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
    return parseVoiceList(stdout);
  } catch {
    return [];
  }
}

/** Parse the tab-separated listing. Empty output (no SAPI voices, or a
 * stripped-down Windows install) yields no voices rather than an error. */
export function parseVoiceList(stdout: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split("\t").map((field) => field.trim());
    const name = fields[0];
    if (!name) continue;
    const culture = fields[1] ?? "";
    const gender = fields[2] ?? "";
    const description = [culture, gender].filter(Boolean).join(" — ");
    voices.push({ id: name, label: name, ...(description ? { description } : {}) });
  }
  return voices;
}

/** Synthesize one utterance to 16 kHz mono 16-bit WAV — small, and every
 * browser plays it. The utterance text rides in as UTF-8 base64 so no
 * character can break out of the PowerShell quoting; the voice id is a
 * SAPI voice name (empty falls back to the system default voice). */
export async function synthesizeWindows(text: string, voiceId: string | undefined, run: Runner = defaultRun): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const dir = await mkdtemp(join(tmpdir(), "openmausbot-sapi-"));
  const out = join(dir, "utterance.wav");
  try {
    const encoded = Buffer.from(trimmed, "utf8").toString("base64");
    const parts = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)))`,
    ];
    if (voiceId?.trim()) parts.push(`$s.SelectVoice('${voiceId.trim().replace(/'/g, "''")}')`);
    parts.push(`$s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`, "$s.Dispose()");
    await run(powershell(), ["-NoProfile", "-NonInteractive", "-Command", parts.join("; ")], 30_000);
    return { bytes: new Uint8Array(await readFile(out)), mime: "audio/wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
