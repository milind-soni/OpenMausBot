import { createHash } from "node:crypto";

export const SCREEN_CONTEXT_LIMITS = Object.freeze({ intervalMs: 5_000, ttlMs: 30_000, maxFrames: 3, maxFrameBytes: 400_000 });

export function createScreenContext({ captureFrame, onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = SCREEN_CONTEXT_LIMITS.intervalMs } = {}) {
  if (typeof captureFrame !== "function") throw new TypeError("captureFrame is required");
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new RangeError("intervalMs must be at least 1000");
  let active = false;
  let disposed = false;
  let generation = 0;
  let pending = false;
  let timer = null;
  let records = [];
  let error = null;

  function prune() {
    records = records.filter(frame => now() - frame.capturedAt < SCREEN_CONTEXT_LIMITS.ttlMs);
  }

  function snapshot() {
    prune();
    return { active, capturing: pending && active, error, frameCount: records.length,
      lastCapturedAt: records.at(-1)?.capturedAt ?? null,
      displayId: records.at(-1)?.displayId ?? null };
  }

  function notify() {
    try { onChange(snapshot()); } catch {}
  }

  function schedule() {
    if (!active || disposed || timer !== null) return;
    timer = setTimer(() => { timer = null; void capture(); }, intervalMs);
    timer?.unref?.();
  }

  async function capture() {
    if (!active || disposed || pending) return;
    pending = true;
    const started = generation;
    try {
      const frame = await captureFrame();
      if (!active || disposed || started !== generation) return;
      if (!frame || typeof frame.dataUrl !== "string" || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(frame.dataUrl)
        || Buffer.byteLength(frame.dataUrl) > SCREEN_CONTEXT_LIMITS.maxFrameBytes) {
        throw Object.assign(new Error("Invalid screen frame"), { code: "capture-unavailable" });
      }
      prune();
      const hash = createHash("sha256").update(frame.dataUrl).digest("hex");
      const record = { dataUrl: frame.dataUrl, displayId: String(frame.displayId ?? ""), capturedAt: now(), hash };
      if (records.at(-1)?.hash === hash && records.at(-1)?.displayId === record.displayId) records[records.length - 1] = record;
      else records.push(record);
      records = records.slice(-SCREEN_CONTEXT_LIMITS.maxFrames);
      error = null;
    } catch (cause) {
      if (!active || disposed || started !== generation) return;
      records = [];
      error = ["screen-permission-denied", "screen-suspended"].includes(cause?.code) ? cause.code : "capture-unavailable";
    } finally {
      pending = false;
      if (active && !disposed) { notify(); schedule(); }
    }
  }

  function pause() {
    active = false;
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    records = [];
    error = null;
    notify();
    return snapshot();
  }

  return {
    start() {
      if (!disposed && !active) {
        active = true;
        generation += 1;
        void capture();
        notify();
      }
      return snapshot();
    },
    pause,
    snapshot,
    frames() { prune(); return records.map(frame => ({ ...frame })); },
    dispose() { disposed = true; pause(); },
  };
}

export function createDesktopScreenCapture({ desktopCapturer, screen, systemPreferences,
  platform = process.platform, isSuspended = () => false }) {
  return async function captureFrame() {
    if (isSuspended()) throw Object.assign(new Error("Screen is suspended"), { code: "screen-suspended" });
    if (platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
      throw Object.assign(new Error("Screen recording permission is denied"), { code: "screen-permission-denied" });
    }
    const displayId = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 960, height: 600 }, fetchWindowIcons: false });
    if (isSuspended()) throw Object.assign(new Error("Screen is suspended"), { code: "screen-suspended" });
    const source = sources.find(item => item.display_id === displayId);
    if (!source || source.thumbnail.isEmpty()) throw new Error("The selected display is unavailable");
    const dataUrl = `data:image/jpeg;base64,${source.thumbnail.toJPEG(55).toString("base64")}`;
    return { dataUrl, displayId };
  };
}
