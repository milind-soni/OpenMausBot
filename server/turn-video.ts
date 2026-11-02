// No model here speaks video natively (OpenAI's chat-completions content parts are only "text" and "image_url",
// and a local vision model takes the same two); ffmpeg on PATH stands in by sampling stills from the clip.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnImageInput, TurnVideoInput } from "./contracts.ts";

export const VIDEO_SAMPLE_FRAME_COUNT = 4;
const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 20_000;
// Generous past any driver's turn timeout, so a slow tool loop still finds its frames; this is a leak bound, not a lease.
const FRAME_CLEANUP_DELAY_MS = 10 * 60 * 1000;

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

async function videoDurationSeconds(path: string): Promise<number> {
  const stdout = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    FFPROBE_TIMEOUT_MS,
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("ffprobe could not read this video's duration");
  return seconds;
}

async function extractFrame(videoPath: string, atSeconds: number, outPath: string): Promise<void> {
  await run("ffmpeg", [
    "-ss", atSeconds.toFixed(3),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "4",
    "-vf", "scale='min(1024,iw)':-2",
    "-y", outPath,
  ], FFMPEG_TIMEOUT_MS);
}

/**
 * Samples a handful of evenly spaced stills from an attached video so a model with only image input can see what
 * it contains. Frames live in their own temp directory, cleaned up on a delay rather than right after this call,
 * since the caller's driver still has to read each frame's path off disk later in the same turn.
 */
export async function videoFrameImages(videos: readonly TurnVideoInput[] | undefined): Promise<TurnImageInput[]> {
  if (!videos?.length) return [];
  const frames: TurnImageInput[] = [];
  for (const video of videos) {
    let dir: string | undefined;
    try {
      const duration = await videoDurationSeconds(video.path);
      const count = Math.min(VIDEO_SAMPLE_FRAME_COUNT, Math.max(1, Math.ceil(duration)));
      dir = await mkdtemp(join(tmpdir(), "omb-video-frame-"));
      for (let index = 0; index < count; index += 1) {
        const atSeconds = (duration * (index + 0.5)) / count;
        const outPath = join(dir, `frame-${index}.jpg`);
        await extractFrame(video.path, atSeconds, outPath);
        const bytes = await readFile(outPath);
        frames.push({ path: outPath, mime: "image/jpeg", bytes: bytes.byteLength, source: "video-frame" });
      }
    } catch {
      // ffmpeg/ffprobe missing, or a container this build cannot decode: the turn proceeds without this video's frames.
    } finally {
      if (dir) {
        const cleanup = dir;
        setTimeout(() => { void rm(cleanup, { recursive: true, force: true }); }, FRAME_CLEANUP_DELAY_MS);
      }
    }
  }
  return frames;
}
