import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TurnVideoInput } from "./contracts.ts";
import { videoFrameImages } from "./turn-video.ts";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// These exercise the real ffmpeg/ffprobe on PATH (the same local build OpenMausBot would find), not a fake: this
// module has nothing to fake ffmpeg's behaviour against. Skipped wherever neither is installed.
describe.skipIf(!hasFfmpeg())("video frame sampling", () => {
  const temporary: string[] = [];

  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "omb-turn-video-"));
    temporary.push(root);
    return root;
  };

  // A generated test pattern, not a sample file in the repo: duration and a readable-by-ffmpeg guarantee come free.
  const syntheticClip = (root: string, seconds: number): TurnVideoInput => {
    const path = join(root, "clip.mp4");
    const result = spawnSync("ffmpeg", [
      "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=320x240:rate=5`,
      "-pix_fmt", "yuv420p", "-y", path,
    ]);
    if (result.status !== 0) throw new Error(`fixture ffmpeg failed: ${result.stderr?.toString()}`);
    return { path, mime: "video/mp4", bytes: 0 };
  };

  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("returns no frames when there is no video", async () => {
    expect(await videoFrameImages(undefined)).toEqual([]);
    expect(await videoFrameImages([])).toEqual([]);
  });

  it("samples frames spaced across the clip, each a valid JPEG tagged as a video frame", async () => {
    const root = store();
    const clip = syntheticClip(root, 5);

    const frames = await videoFrameImages([clip]);

    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(frame.mime).toBe("image/jpeg");
      expect(frame.source).toBe("video-frame");
      const bytes = readFileSync(frame.path);
      expect(bytes.length).toBe(frame.bytes);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    // Each frame is its own file, not the same still repeated.
    expect(new Set(frames.map((frame) => frame.path)).size).toBe(4);
  });

  it("samples fewer frames from a clip shorter than the usual frame count", async () => {
    const root = store();
    const clip = syntheticClip(root, 2);

    const frames = await videoFrameImages([clip]);

    expect(frames).toHaveLength(2);
  });

  it("drops a video ffmpeg cannot read instead of failing the turn", async () => {
    const root = store();
    const notAVideo: TurnVideoInput = { path: join(root, "missing.mp4"), mime: "video/mp4", bytes: 0 };

    await expect(videoFrameImages([notAVideo])).resolves.toEqual([]);
  });
});
