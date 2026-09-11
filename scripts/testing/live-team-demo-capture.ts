// Capture the owned fixture page with wall-clock timestamps. Static reading
// pauses survive encoding instead of collapsing into a few screencast frames.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export async function startDemoCapture(endpoint: string, pageUrl: string, directory: string) {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(Error("Cannot connect to the fixture recorder")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const command = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const frames: { file: string; at: number }[] = [];
  const framesDirectory = join(directory, "demo-frames");
  mkdirSync(framesDirectory, { recursive: true });
  let started = performance.now();
  let activeSession = "";
  let accepting = true;
  const saveFrame = (data: string) => {
    const file = `frame-${String(frames.length).padStart(6, "0")}.jpg`;
    const at = (performance.now() - started) / 1000;
    writeFileSync(join(framesDirectory, file), Buffer.from(data, "base64"));
    frames.push({ file, at });
  };
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else if (message.method === "Page.screencastFrame" && message.sessionId === activeSession) {
      if (accepting) saveFrame(message.params.data);
      void command("Page.screencastFrameAck", { sessionId: message.params.sessionId }, activeSession).catch(() => {});
    }
  });
  try {
    const { targetInfos } = await command("Target.getTargets");
    const target = targetInfos.find((item: any) => item.type === "page" && item.url === pageUrl);
    if (!target) throw Error("Cannot find the exact owned fixture page for recording");
    activeSession = (await command("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    const first = await command("Page.captureScreenshot", { format: "jpeg", quality: 98 }, activeSession);
    started = performance.now();
    saveFrame(first.data);
    frames[0].at = 0;
    await command("Page.startScreencast", { format: "jpeg", quality: 98, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, activeSession);
  } catch (error) {
    socket.close();
    throw error;
  }
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      const duration = (performance.now() - started) / 1000;
      accepting = false;
      try {
        await command("Page.stopScreencast", {}, activeSession);
      } finally {
        socket.close();
      }
      const list = frames.map((frame, index) => `file '${frame.file}'\noption framerate 1000\nduration ${Math.max(0.001, (frames[index + 1]?.at ?? duration) - frame.at).toFixed(6)}`).join("\n") + `\nfile '${frames.at(-1)!.file}'\noption framerate 1000\n`;
      const manifest = join(framesDirectory, "frames.ffconcat");
      writeFileSync(manifest, list);
      await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", manifest, "-vf", "fps=30", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(directory, "launch-demo-1080p.mp4")], { timeout: 120_000 });
      writeFileSync(join(directory, "demo-recording.json"), JSON.stringify({ duration, capturedFrames: frames.length, width: 1920, height: 1080, outputFps: 30, source: "Isolated fake-engine fixture with real app events", timestamps: "Wall-clock capture, static frames held through reading pauses" }, null, 2));
    },
  };
}
