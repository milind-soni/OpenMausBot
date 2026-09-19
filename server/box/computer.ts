// Box computer panel surface — status, the owner-scoped console,
// panel screenshots, and the ComputerBackend arm.

import type { BoxComputerBackend, ComputerScreenshotFrame } from "../computer-backend.ts";
import type { AppConfig } from "../config.ts";
import { boxConfigured, boxFetch, boxJson, READY, snapshotBoxConfig } from "./api.ts";
import { isolatedRemoteCommand, MAX_REMOTE_COMMAND_LENGTH, runCommand } from "./commands.ts";
import {
  deleteManagedBox,
  findBox,
  joinBox,
  joinReadyBox,
  provisionBox,
  sleepBox,
  waitReady,
} from "./lifecycle.ts";
import { listManagedBoxes } from "./inventory.ts";

/** Box state for the Computer panel. */
export interface BoxComputerStatus {
  configured: boolean;
  box: { boxId: string; state: string; desktopAvailable: boolean | null } | null;
}

export async function boxStatus(cfg: AppConfig, botId: string): Promise<BoxComputerStatus> {
  cfg = snapshotBoxConfig(cfg);
  if (!boxConfigured(cfg)) return { configured: false, box: null };
  const box = await findBox(cfg, botId);
  return {
    configured: true,
    box: box ? { boxId: box.id, state: box.state, desktopAvailable: box.desktopAvailable ?? null } : null,
  };
}

/** Owner-scoped shell for the Computer panel's console. */
export async function execOnBox(cfg: AppConfig, botId: string, command: string) {
  cfg = snapshotBoxConfig(cfg);
  if (command.length > MAX_REMOTE_COMMAND_LENGTH) {
    throw new RangeError(`command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`);
  }
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot yet");
  const ready = await waitReady(cfg, box.id, 60_000);
  if (!ready) throw new Error("box did not wake");
  const out = await runCommand(cfg, box.id, isolatedRemoteCommand(command));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

// Screenshot for the Computer panel + screen-in-chat. Two hops: capture
// to a file on the box (scrot straight to JPEG — no ImageMagick startup
// unless a downscale is actually needed), then read the bytes back.
// Base64 over command stdout is NOT reliable for the panel's full-size
// frames (probed 2026-08-12: an otherwise-complete payload came back with
// a corrupted length), so the frame is always fetched over HTTP here.
//
// The frame is for a person: it fills the panel and opens in the chat's
// image viewer, so it keeps the desktop's native size up to 1080p and a
// quality where page text stays legible. (Sizing it is now the only say
// OpenMausBot has over any frame off this box: the turn runs on the box's
// own agent, so the model's own captures never pass through here.) Only
// wider displays are scaled down, with -resize rather than -thumbnail so
// the resample is not the fast-and-blurry kind meant for icons. The
// pointer is drawn into the frame (scrot --pointer, ffmpeg -draw_mouse):
// watching the bot work means seeing where its cursor is, and X11
// captures leave it out by default.
const PANEL_PATH = "/tmp/ogb-panel.jpg";
export const PANEL_FRAME_WIDTH = 1920;
export const PANEL_FRAME_QUALITY = 85;
// ffmpeg's -q:v runs 2 (best) to 31; 3 lands near JPEG quality 85.
const PANEL_FRAME_FFMPEG_Q = 3;

/** The shell that captures one panel frame on the box. Exported for tests. */
export function panelShotCommand({ width = PANEL_FRAME_WIDTH, quality = PANEL_FRAME_QUALITY } = {}): string {
  return [
    "export DISPLAY=${DISPLAY:-:0}",
    `f=${PANEL_PATH}`,
    // a stale frame must not pass `test -s` when every capture tool fails
    'rm -f "$f"',
    'w=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1)',
    'case "$w" in ""|*[!0-9]*) w=0;; esac',
    `scrot -o -p -q ${quality} "$f" 2>/dev/null || import -window root -quality ${quality} "$f" 2>/dev/null || ffmpeg -y -f x11grab -draw_mouse 1 -i "$DISPLAY" -frames:v 1 -q:v ${PANEL_FRAME_FFMPEG_Q} "$f" >/dev/null 2>&1`,
    `if [ "$w" -gt ${width} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -resize ${width}x -quality ${quality} "$f" 2>/dev/null || true; fi`,
    'test -s "$f" && echo captured',
  ].join("; ");
}
const SHOT_CMD = panelShotCommand();

// A compromised box can answer with an arbitrarily large "frame"; cap what
// the server ever buffers for one (raw bytes, before base64) so a single
// response cannot exhaust memory.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_TOO_LARGE = "the box frame exceeds the 8 MB limit";

/** Read a file off the box as base64 — raw artifact bytes when the API
 * supports it (33% less transfer, no JSON envelope), else the files API. */
async function readFileBase64(cfg: AppConfig, boxId: string, path: string): Promise<string | null> {
  let bytes: Buffer | null = null;
  let tooLarge = false;
  try {
    const res = await boxFetch(cfg, `/boxes/${boxId}/artifacts?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const declaredLength = res.headers.get("content-length");
      if (declaredLength !== null && Number(declaredLength) > MAX_FRAME_BYTES) tooLarge = true;
      else bytes = Buffer.from(await res.arrayBuffer());
    }
  } catch {
    /* fall through */
  }
  if (tooLarge || (bytes !== null && bytes.length > MAX_FRAME_BYTES)) {
    throw new Error(FRAME_TOO_LARGE);
  }
  if (bytes?.length) return bytes.toString("base64");
  const { ok, body } = await boxJson(cfg, `/boxes/${boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`);
  const content = body?.content;
  if (ok && typeof content === "string" && content) {
    if (Buffer.byteLength(content, "base64") > MAX_FRAME_BYTES) throw new Error(FRAME_TOO_LARGE);
    return content;
  }
  return null;
}

/** `knownBoxId` skips box resolution entirely — the screen poller holds
 * the id for the whole turn and must not re-resolve it every frame. */
export async function screenshotBox(
  cfg: AppConfig,
  botId: string,
  knownBoxId?: string,
): Promise<ComputerScreenshotFrame> {
  cfg = snapshotBoxConfig(cfg);
  let boxId = knownBoxId;
  if (!boxId) {
    const box = await findBox(cfg, botId);
    if (!box) throw new Error("no computer for this bot yet");
    if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
    boxId = box.id as string;
  }
  const out = await runCommand(cfg, boxId, SHOT_CMD, { timeoutMs: 60_000 });
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the box");
  }
  const data = await readFileBase64(cfg, boxId, PANEL_PATH);
  if (!data) throw new Error("could not read the frame back from the box");
  return { png: data, format: "jpeg" };
}

/** The Box arm of the shared ComputerBackend dispatch (computer-backend.ts).
 * Thin adapters over the module's own functions; Box-specific lifecycle
 * policy (find/wake gates) stays with its callers. */
export const boxComputerBackend: BoxComputerBackend = {
  kind: "box",
  status: (cfg, botId) => boxStatus(cfg, botId),
  action: (cfg, botId, action, input = {}) => {
    if (action === "provision") return provisionBox(cfg, botId, input.botName ?? "");
    if (action === "sleep") return sleepBox(cfg, botId);
    return execOnBox(cfg, botId, input.command ?? "");
  },
  screenshot: (cfg, botId, knownBoxId) => screenshotBox(cfg, botId, knownBoxId),
  join: (cfg, botId, mode) => (mode === "ready" ? joinReadyBox(cfg, botId) : joinBox(cfg, botId)),
  closeViewer: () => ({ closed: false }),
  inventory: (cfg, owners, options) => listManagedBoxes(cfg, owners, options),
  removeManaged: (cfg, owners, boxId, confirmName, claim, options) =>
    deleteManagedBox(cfg, owners, boxId, confirmName, claim, options),
};
