// Local speech-to-text for desktops without Apple's recognizer.
// The model file is downloaded only after the person confirms.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { WHISPER_MODEL, binaryAsset, whisperLanguage } from "./dictation-languages.mjs";

const MIN_MODEL_BYTES = 100_000_000;

export function whisperRoot(userData) {
  return path.join(userData, "whisper");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findCli(dir) {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (/^(whisper-cli|main)(\.exe)?$/i.test(entry.name)) return full;
    }
  }
  return null;
}

export async function whisperStatus(userData) {
  const root = whisperRoot(userData);
  const model = path.join(root, WHISPER_MODEL.fileName);
  let modelBytes = 0;
  try {
    modelBytes = (await stat(model)).size;
  } catch {
    modelBytes = 0;
  }
  const cli = await findCli(root);
  return {
    installed: modelBytes >= MIN_MODEL_BYTES && Boolean(cli),
    model: WHISPER_MODEL.label,
    modelBytes,
  };
}

export function parseWhisperTranscript(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "[BLANK_AUDIO]" && !line.startsWith("whisper_") && !line.startsWith("ggml_"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function downloadFile(url, dest, { signal, onProgress }) {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status || "no body"})`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const partial = `${dest}.partial`;
  await mkdir(path.dirname(dest), { recursive: true });
  const stream = Readable.fromWeb(response.body);
  stream.on("data", (chunk) => {
    received += chunk.length;
    onProgress?.({ received, total, phase: "model" });
  });
  try {
    await pipeline(stream, createWriteStream(partial), { signal });
    await rm(dest, { force: true });
    await rename(partial, dest);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function extractArchive(archive, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", dest], { windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not unpack the speech engine (tar exited ${code})`));
    });
  });
}

/**
 * Download Whisper Large v3 Turbo and the matching whisper.cpp binary.
 * Resolves once both are on disk and the microphone can start a session.
 */
export async function downloadWhisper({ userData, platform = process.platform, arch = process.arch, signal, onProgress }) {
  const asset = binaryAsset(platform, arch);
  if (!asset) throw new Error("This computer has no local speech engine build.");
  const root = whisperRoot(userData);
  await mkdir(root, { recursive: true });
  const model = path.join(root, WHISPER_MODEL.fileName);
  if (!(await exists(model)) || (await stat(model)).size < MIN_MODEL_BYTES) {
    await downloadFile(WHISPER_MODEL.url, model, { signal, onProgress });
  }
  if (!(await findCli(root))) {
    onProgress?.({ received: 0, total: 0, phase: "engine" });
    const archive = path.join(root, asset.file);
    await downloadFile(asset.url, archive, { signal, onProgress: (progress) => onProgress?.({ ...progress, phase: "engine" }) });
    await extractArchive(archive, root);
    await rm(archive, { force: true });
    if (!(await findCli(root))) throw new Error("The speech engine unpacked without a recognizer.");
  }
  return whisperStatus(userData);
}

export async function transcribeWav({ userData, wavPath, language }) {
  const status = await whisperStatus(userData);
  if (!status.installed) throw new Error("Whisper Large v3 Turbo is not installed.");
  const cli = await findCli(whisperRoot(userData));
  if (!cli) throw new Error("Whisper Large v3 Turbo is not installed.");
  const code = whisperLanguage(language);
  const args = ["-m", path.join(whisperRoot(userData), WHISPER_MODEL.fileName), "-f", wavPath, "-l", code, "-nt", "-np"];
  const cliDir = path.dirname(cli);
  const env = { ...process.env };
  if (process.platform !== "win32") {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${cliDir}${path.delimiter}${env.LD_LIBRARY_PATH}` : cliDir;
  }
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(cli, args, { windowsHide: true, cwd: cliDir, env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (exit) => {
      clearTimeout(timer);
      if (exit === 0) resolve(out);
      else reject(new Error((err.trim() || `Speech recognition failed (${exit})`).slice(0, 500)));
    });
  });
  return { text: parseWhisperTranscript(stdout) };
}
